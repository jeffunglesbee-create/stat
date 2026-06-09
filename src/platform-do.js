/**
 * STAT — Platform-Grouped Durable Objects
 *
 * Architecture: one DO per ATS platform instead of one DO per company.
 * Each platform DO wakes on the time-aware schedule, iterates ALL companies
 * of that ATS type, fetches each, deduplicates, scores, and alerts.
 *
 * Cost model:
 *   7 setAlarm() calls per cycle (one per platform)
 *   vs N setAlarm() calls per cycle in per-company architecture (one per company)
 *   At 3,000 companies: 7 writes vs 3,000 writes per alarm cycle
 *   Alarm writes become negligible against the 50M/month SQLite included tier
 *
 * SQLite storage backend (declared via new_sqlite_classes in wrangler.toml):
 *   Included: 50M rows written/month vs 1M write-units on KV backend
 *   This DO uses get/put (KV-style) which Cloudflare maps to SQLite rows
 *   No SQL code needed — same API, better billing tier
 *
 * Hibernation: DOs hibernate between alarms — zero duration billing while idle
 *   Only active CPU during alarm execution counts toward CPU billing
 *
 * Per-platform pacing: each platform has an ATS-appropriate floor interval
 *   (greenhouse/lever/ashby: 2min floor; workday/icims: 4min; SF/taleo: 8min)
 *   Polite delay between individual company fetches within each cycle
 *
 * Scaling: adding 1,000 more Greenhouse companies costs zero additional alarms.
 *   Only CPU time for the extra API calls. At 10ms/call: 10,000 calls = 100s CPU
 *   = 100,000 CPU-ms. At $0.02/M: $0.002. Effectively free.
 */

import {
  fetchGreenhouse, fetchLever, fetchAshby,
  fetchWorkday, fetchICIMS, fetchSuccessFactors, fetchTaleo, fetchOracleHcm, fetchInforHcm,
  fetchSelectMinds,
} from './adapters.js';
import { matchJob, passesEnvFilter, dispatchAlerts, checkJobLiveness } from './notify.js';
import { enrichJobWithSalary } from './salary.js';
import { scoreBatch, companyAwarePriority } from './fit.js';
import { getStatStore, storeGet, storeSet, saveRecentMatches, saveUnmatchedJobs, appendLog, maybeAddOrPromoteCompany } from './store.js';
import { getPollingInterval, KV, GHOST } from './config.js';
import { applyMarylandScore } from './maryland.js';
import { enrichDescriptions } from './enrich.js';

// ─────────────────────────────────────────────────────────────────────────────
// Base class — all platform DOs extend this
// ─────────────────────────────────────────────────────────────────────────────
class PlatformDO {
  constructor(state, env, atsKey) {
    this.state  = state;
    this.env    = env;
    this.ats    = atsKey;         // 'greenhouse' | 'lever' | etc.
    this.storage = state.storage;
  }

  // ── HTTP: init + status ───────────────────────────────────────────────────
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/init' && request.method === 'POST') {
      const existing = await this.storage.getAlarm();
      if (!existing) {
        await this.storage.setAlarm(Date.now() + 5_000);
        await this.storage.put('started_at', new Date().toISOString());
      }
      return ok({ started: true, ats: this.ats });
    }

    if (url.pathname === '/status') {
      const lastRun      = await this.storage.get('last_run')      ?? null;
      const totalPolled  = await this.storage.get('total_polled')  ?? 0;
      const totalMatches = await this.storage.get('total_matches') ?? 0;
      const seenCount    = await this.storage.get('seen_count')    ?? 0;
      const nextAlarm    = await this.storage.getAlarm();
      // Include selectminds cursor in status for diagnostics
      const smCursor = this.ats === 'selectminds'
        ? (await this.storage.get('selectminds_cursor') ?? null)
        : undefined;
      return ok({ ats: this.ats, lastRun, totalPolled, totalMatches, seenCount, nextAlarm,
        ...(smCursor !== undefined ? { selectmindsCursor: smCursor } : {}) });
    }

    if (url.pathname === '/reset-seen' && request.method === 'POST') {
      await this.storage.put('seen_ids', JSON.stringify([]));
      await this.storage.put('seen_count', 0);
      return ok({ cleared: true });
    }

    return new Response('Not found', { status: 404 });
  }

  // ── Alarm: fetch all companies for this ATS ───────────────────────────────
  async alarm() {
    // Load this platform's company list from KV
    let allCompanies;
    try {
      const raw = await storeGet(getStatStore(this.env), 'company_list');
      const list = raw ? JSON.parse(raw) : [];
      allCompanies = list.filter(c => c.ats === this.ats);
    } catch (e) {
      console.error(`[STAT ${this.ats}] Failed to load company list:`, e.message);
      await this._reschedule();
      return;
    }

    if (allCompanies.length === 0) {
      await this._reschedule();
      return;
    }

    // Load per-platform seen-set (stored in DO storage, not KV)
    let seenIds;
    try {
      const raw = await this.storage.get('seen_ids');
      seenIds = raw ? new Set(JSON.parse(raw)) : new Set();
    } catch (e) { console.warn(`[STAT ${this.ats}] seenIds load failed (dedup may be incomplete):`, e.message); seenIds = new Set(); }

    // Load profile-generated custom keywords (profile-driven contextual matching)
    let customKeywords = null;
    try {
      const ckRaw = await storeGet(getStatStore(this.env), 'custom_keywords');
      if (ckRaw) {
        const ckData = JSON.parse(ckRaw);
        customKeywords = ckData.keywords || null;
      }
    } catch { /* custom keywords optional — static list is fallback */ }

    // Also load global seen-map for cross-platform dedup
    // Format: Map<id, {id, seenAt, diedAt?, url?}> — structured for TTL + ghost resurrection
    let globalSeen;
    try {
      const raw = await storeGet(getStatStore(this.env), 'seen_ids');
      if (raw) {
        const arr = JSON.parse(raw);
        globalSeen = new Map(arr.map(e => {
          const entry = typeof e === 'string' ? { id: e, seenAt: new Date(0).toISOString() } : e;
          return [entry.id, entry];
        }));
      } else {
        globalSeen = new Map();
      }
    } catch (e) { console.warn(`[STAT ${this.ats}] globalSeen load failed (cross-platform dedup may be incomplete):`, e.message); globalSeen = new Map(); }

    const newMatches    = [];
    const unmatchedJobs = [];   // env-filtered, not keyword-matched
    const errorLog      = [];   // per-company errors for /logs diagnostic
    const brLog        = [];   // Workday BR path results: {company, source, jobs}
    let polledCount  = 0;

    // CHUNKED POLLING with cursor rotation.
    // Platform DOs have ~30s CPU per alarm. With 400ms delay between fetches,
    // max ~70 companies per alarm safely. We rotate through the full list using
    // a cursor stored in DO storage, so every company gets polled over time.
    const CHUNK_SIZE = 15; // 15 companies × 400ms = 6s, well within 30s limit
    let cursor = 0;
    try {
      cursor = (await this.storage.get('poll_cursor') ?? 0) % allCompanies.length;
    } catch {}

    // SelectMinds ID-walk cursor — persisted separately from the company chunk cursor.
    // Loaded once per alarm cycle, written back after fetchSelectMinds returns.
    if (this.ats === 'selectminds') {
      try {
        this._selectmindsCursor = await this.storage.get('selectminds_cursor') ?? null;
        if (this._selectmindsCursor !== null) this._selectmindsCursor = parseInt(this._selectmindsCursor, 10);
      } catch { this._selectmindsCursor = null; }
    }

    // Slice the chunk starting at cursor, wrapping around
    const chunk = [];
    for (let i = 0; i < CHUNK_SIZE && i < allCompanies.length; i++) {
      chunk.push(allCompanies[(cursor + i) % allCompanies.length]);
    }
    // Advance cursor for next alarm
    try {
      await this.storage.put('poll_cursor', (cursor + CHUNK_SIZE) % allCompanies.length);
    } catch {}

    // Fetch each company in this chunk — polite delay between requests
    for (const company of chunk) {
      try {
        const jobs = await this._fetchJobs(company);
        polledCount++;

        // Persist SelectMinds ID-walk cursor returned by fetchSelectMinds
        if (this.ats === 'selectminds' && jobs._nextCursor != null) {
          this._selectmindsCursor = jobs._nextCursor;
          try { await this.storage.put('selectminds_cursor', String(jobs._nextCursor)); } catch {}
        }

        // Capture Workday BR path result for /logs diagnostic
        if (this.ats === 'workday') {
          brLog.push({ company: company.name, source: jobs._source || 'empty', jobs: jobs.length });
        }

        for (const job of jobs) {
          // Ghost filter
          if (job.daysAgo !== null) {
            if (job.daysAgo > GHOST.suppress_after_days) continue;
            if (job.daysAgo > GHOST.warn_after_days) job.ghostFlag = 'warn';
          }
          if (job.ghostFlag === 'suppress') continue;

          // Browse capture: ALL env-filtered jobs go to Browse, including matched ones.
          // Seen-set dedup is for ALERT dedup only — not Browse visibility.
          // Matched jobs stay discoverable in Browse after the recent_matches rolling
          // window closes (200-entry cap). Browse is the full picture surface.
          if (passesEnvFilter(job)) {
            unmatchedJobs.push(job);
          }

          // Dedup: check both local per-DO seen-set (Set) and global seen-map (Map)
          const globalStatus = globalSeen.has(job.id)
            ? (globalSeen.get(job.id)?.diedAt ? 'dead' : 'seen')
            : null;

          if (seenIds.has(job.id) || globalStatus === 'seen') continue;

          if (globalStatus === 'dead') {
            // Ghost resurrection: re-check liveness — if live, clear diedAt and re-alert
            const liveness = await checkJobLiveness(job);
            if (liveness !== 'live') { seenIds.add(job.id); continue; }
            const entry = globalSeen.get(job.id);
            if (entry) delete entry.diedAt;
            console.log(`[STAT ${this.ats}] Ghost resurrected: ${job.id} ${job.title}`);
            // Fall through to match pipeline
          }

          seenIds.add(job.id);
          // Add to global seen-map with URL for future liveness sweeps
          globalSeen.set(job.id, {
            id:     job.id,
            seenAt: new Date().toISOString(),
            ...(job.url ? { url: job.url } : {}),
          });

          if (!passesEnvFilter(job)) continue;
          const match = matchJob(job, customKeywords);
          if (!match) continue; // already captured above

          const liveness = await checkJobLiveness(job);
          if (liveness === 'dead') {
            // Mark dead in global seen-map for future sweep resurrection
            const entry = globalSeen.get(job.id);
            if (entry) { entry.diedAt = new Date().toISOString(); }
            continue;
          }
          job.liveness = liveness;

          await enrichJobWithSalary(job, match, this.env);

          const adjustedPriority = companyAwarePriority(job, match);
          const adjustedMatch    = adjustedPriority !== match.priority
            ? { ...match, priority: adjustedPriority } : match;

          job.matchedKeyword = match.matchedKw;
          job._matchGroup    = adjustedMatch.label;
          job._company       = company; // carry company meta for batch MD scoring

          newMatches.push({ job, match: adjustedMatch });

          // Auto-discovery: track health system matches, promote to DO polling
          // gate:'strict' filters out non-healthcare companies (Lightspeed, IBM etc.)
          maybeAddOrPromoteCompany(env, job, { gate: 'strict' }).catch(() => {});
        }

        // Polite inter-company delay
        await new Promise(r => setTimeout(r, 150)); // Epic-first search is lighter

      } catch (e) {
        console.warn(`[STAT ${this.ats}] ${company.name} error:`, e.message);
        errorLog.push({ company: company.name, error: e.message });
      }
    }

    // ── Second-pass description fetch + Maryland batch scoring ─────────────
    // enrichDescriptions fetches og:description for Workday/iCIMS/SF/Taleo matches.
    // Only fires for genuinely new matches — typically 0-5 requests per alarm cycle.
    // applyMarylandScore runs after description is available for accurate scoring.
    if (newMatches.length > 0) {
      await enrichDescriptions(newMatches, this.env);

      // Apply MD scoring now that descriptions are populated
      // Filter out any explicitly MD-excluded jobs
      const mdFiltered = [];
      for (const m of newMatches) {
        const suppressed = applyMarylandScore(m.job, m.job._company);
        if (!suppressed) mdFiltered.push(m);
        delete m.job._company; // clean up temp field
      }
      newMatches.length = 0;
      newMatches.push(...mdFiltered);
    }

    // Persist local seen-set (cap at 10,000 per platform)
    let seenArr = Array.from(seenIds);
    if (seenArr.length > 10_000) seenArr = seenArr.slice(-10_000);
    await this.storage.put('seen_ids',   JSON.stringify(seenArr));
    await this.storage.put('seen_count', seenArr.length);
    await this.storage.put('last_run',   new Date().toISOString());

    // Persist global seen-map back to StateStoreDO
    // Prune dead entries older than 30 days; hard-cap at max_seen
    try {
      const now = Date.now();
      const SEEN_TTL = 30 * 24 * 60 * 60 * 1000;
      let gArr = Array.from(globalSeen.values()).filter(e => {
        if (e.diedAt && (now - new Date(e.diedAt).getTime()) > SEEN_TTL) return false;
        return true;
      });
      if (gArr.length > KV.max_seen) gArr = gArr.slice(-KV.max_seen);
      await storeSet(getStatStore(this.env), 'seen_ids', JSON.stringify(gArr));
    } catch (e) {
      console.warn(`[STAT ${this.ats}] Global seen-set save failed:`, e.message);
    }

    // Update totals
    const prev = {
      polled:  (await this.storage.get('total_polled'))  ?? 0,
      matches: (await this.storage.get('total_matches')) ?? 0,
    };
    await this.storage.put('total_polled',  prev.polled  + polledCount);
    await this.storage.put('total_matches', prev.matches + newMatches.length);

    // Fit score + dispatch
    if (newMatches.length > 0) {
      try {
        const profileRaw = await storeGet(getStatStore(this.env), 'resume_profile');
        const profile    = profileRaw ? JSON.parse(profileRaw) : null;
        if (profile && this.env.GEMINI_KEY) {
          await scoreBatch(newMatches, profile, this.env.GEMINI_KEY);
        }
      } catch (e) {
        console.warn(`[STAT ${this.ats}] Fit scoring skipped:`, e.message);
      }
      console.log(`[STAT ${this.ats}] ${newMatches.length} matches from ${polledCount} companies`);
      await dispatchAlerts(this.env, newMatches);
      // Store matches in rolling job history for GET /jobs
      await saveRecentMatches(getStatStore(this.env), newMatches);
    }

    // Save env-filtered non-matches for browsing (outside match gate)
    if (unmatchedJobs.length > 0) {
      await saveUnmatchedJobs(getStatStore(this.env), unmatchedJobs);
    }

    // ── Structured log entry for GET /logs diagnostic endpoint ─────────────
    // Runs unconditionally — every alarm cycle logged, including zero-match cycles.
    // Zero-match cycles are diagnostic signal (confirms polling is running even when quiet).
    // Captures per-alarm-cycle results so CI log-check can surface open questions:
    //   - Which companies are returning 0 jobs consistently?
    //   - Is match rate improving after adapter changes?
    await appendLog(getStatStore(this.env), {
      type:       'alarm',
      ats:        this.ats,
      polled:     polledCount,
      newMatches: newMatches.length,
      cursor:     (cursor + CHUNK_SIZE) % allCompanies.length,
      errors:     errorLog,
      ...(this.ats === 'workday' && brLog.length > 0 ? { br: brLog } : {}),
    });

    await this._reschedule();
  }

  // ── Internal: ATS-specific fetch ─────────────────────────────────────────
  async _fetchJobs(company) {
    switch (this.ats) {
      case 'greenhouse':     return fetchGreenhouse(company);
      case 'lever':          return fetchLever(company);
      case 'ashby':          return fetchAshby(company);
      case 'workday':        return fetchWorkday(company, this.env);
      case 'icims':          return fetchICIMS(company);
      case 'successfactors': return fetchSuccessFactors(company);
      case 'taleo':          return fetchTaleo(company, this.env);
      case 'oracle_hcm':     return fetchOracleHcm(company);
      case 'infor_hcm':      return fetchInforHcm(company);
      case 'selectminds':    return fetchSelectMinds(company, this._selectmindsCursor ?? null);
      default:               return [];
    }
  }

  async _reschedule() {
    const interval = getPollingInterval(this.ats);
    await this.state.storage.setAlarm(Date.now() + interval);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Seven concrete platform classes — each is a separate DO namespace
// SQLite backend declared in wrangler.toml via new_sqlite_classes
// ─────────────────────────────────────────────────────────────────────────────
export class GreenhouseDO     extends PlatformDO {
  constructor(s, e) { super(s, e, 'greenhouse'); }
}
export class LeverDO          extends PlatformDO {
  constructor(s, e) { super(s, e, 'lever'); }
}
export class AshbyDO          extends PlatformDO {
  constructor(s, e) { super(s, e, 'ashby'); }
}
export class WorkdayDO        extends PlatformDO {
  constructor(s, e) { super(s, e, 'workday'); }
}
export class IcimsDO          extends PlatformDO {
  constructor(s, e) { super(s, e, 'icims'); }
}
export class SuccessFactorsDO extends PlatformDO {
  constructor(s, e) { super(s, e, 'successfactors'); }
}
export class TaleoDO          extends PlatformDO {
  constructor(s, e) { super(s, e, 'taleo'); }
}
export class OracleHcmDO      extends PlatformDO {
  constructor(s, e) { super(s, e, 'oracle_hcm'); }
}
export class InforHcmDO       extends PlatformDO {
  constructor(s, e) { super(s, e, 'infor_hcm'); }
}
export class SelectMindsDO    extends PlatformDO {
  constructor(s, e) { super(s, e, 'selectminds'); }
}

// ── Helper ────────────────────────────────────────────────────────────────────
function ok(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}
