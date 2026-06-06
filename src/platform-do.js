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
  fetchWorkday, fetchICIMS, fetchSuccessFactors, fetchTaleo,
} from './adapters.js';
import { matchJob, passesEnvFilter, dispatchAlerts, checkJobLiveness } from './notify.js';
import { enrichJobWithSalary } from './salary.js';
import { scoreBatch, companyAwarePriority } from './fit.js';
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
      return ok({ ats: this.ats, lastRun, totalPolled, totalMatches, seenCount, nextAlarm });
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
      const raw = await this.env.STAT_KV.get(KV.company_list);
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
    } catch { seenIds = new Set(); }

    // Also load global KV seen-set for cross-platform dedup
    let globalSeen;
    try {
      const raw = await this.env.STAT_KV.get(KV.seen_jobs);
      globalSeen = raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { globalSeen = new Set(); }

    const newMatches = [];
    let polledCount  = 0;

    // Fetch each company — polite delay between requests
    for (const company of allCompanies) {
      try {
        const jobs = await this._fetchJobs(company);
        polledCount++;

        for (const job of jobs) {
          // Ghost filter
          if (job.daysAgo !== null) {
            if (job.daysAgo > GHOST.suppress_after_days) continue;
            if (job.daysAgo > GHOST.warn_after_days) job.ghostFlag = 'warn';
          }
          if (job.ghostFlag === 'suppress') continue;

          // Dedup: check both local and global seen-set
          if (seenIds.has(job.id) || globalSeen.has(job.id)) continue;
          seenIds.add(job.id);
          globalSeen.add(job.id);

          if (!passesEnvFilter(job)) continue;
          const match = matchJob(job);
          if (!match) continue;

          const liveness = await checkJobLiveness(job);
          if (liveness === 'dead') continue;
          job.liveness = liveness;

          await enrichJobWithSalary(job, match, this.env);

          const adjustedPriority = companyAwarePriority(job, match);
          const adjustedMatch    = adjustedPriority !== match.priority
            ? { ...match, priority: adjustedPriority } : match;

          job.matchedKeyword = match.matchedKw;
          job._matchGroup    = adjustedMatch.label;
          job._company       = company; // carry company meta for batch MD scoring

          newMatches.push({ job, match: adjustedMatch });
        }

        // Polite inter-company delay
        await new Promise(r => setTimeout(r, 300));

      } catch (e) {
        console.warn(`[STAT ${this.ats}] ${company.name} error:`, e.message);
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

    // Persist global seen-set back to KV
    try {
      let gArr = Array.from(globalSeen);
      if (gArr.length > KV.max_seen) gArr = gArr.slice(-KV.max_seen);
      await this.env.STAT_KV.put(KV.seen_jobs, JSON.stringify(gArr));
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
        const profileRaw = await this.env.STAT_KV.get(KV.resume_profile);
        const profile    = profileRaw ? JSON.parse(profileRaw) : null;
        if (profile && this.env.ANTHROPIC_API_KEY) {
          await scoreBatch(newMatches, profile, this.env.ANTHROPIC_API_KEY);
        }
      } catch (e) {
        console.warn(`[STAT ${this.ats}] Fit scoring skipped:`, e.message);
      }
      console.log(`[STAT ${this.ats}] ${newMatches.length} matches from ${polledCount} companies`);
      await dispatchAlerts(this.env, newMatches);
    }

    await this._reschedule();
  }

  // ── Internal: ATS-specific fetch ─────────────────────────────────────────
  async _fetchJobs(company) {
    switch (this.ats) {
      case 'greenhouse':     return fetchGreenhouse(company);
      case 'lever':          return fetchLever(company);
      case 'ashby':          return fetchAshby(company);
      case 'workday':        return fetchWorkday(company);
      case 'icims':          return fetchICIMS(company);
      case 'successfactors': return fetchSuccessFactors(company);
      case 'taleo':          return fetchTaleo(company);
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

// ── Helper ────────────────────────────────────────────────────────────────────
function ok(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}
