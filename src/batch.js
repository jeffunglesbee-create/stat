/**
 * STAT — BatchPollerDO
 *
 * A single Durable Object that cycles through BATCH_WATCHLIST in chunks,
 * fetching each company's ATS directly on a rotating basis.
 *
 * Cost model: ONE alarm regardless of how many companies are in the list.
 * Adding 1,000 more companies to BATCH_WATCHLIST costs zero additional alarms.
 * Trade-off: freshness is ~4-8min per full cycle rather than per-company.
 *
 * Cycle mechanics:
 *   - BatchPollerDO stores a cursor (last processed index) in DO storage
 *   - Each alarm: fetch BATCH_POLLER.companies_per_cycle companies from cursor
 *   - Advance cursor, reschedule alarm
 *   - Full cycle time: (total_companies / companies_per_cycle) × alarm_interval
 *   - At 60 companies, 50/cycle, 4min alarm → full cycle every 4.8min
 *   - At 500 companies, 50/cycle, 4min alarm → full cycle every 40min
 *   - At 3000 companies, 50/cycle, 4min alarm → full cycle every 4hrs
 *
 * For 3,000 companies at meaningful freshness, tune companies_per_cycle up
 * or alarm_interval down. 200/cycle at 4min = 60min full cycle (still fine
 * given 48hr application window research).
 *
 * DO NOT store one DO per batch company. That defeats the entire purpose.
 */

import { fetchCompanyJobs } from './adapters.js';
import { getStatStore, storeGet, storeSet, saveRecentMatches, saveUnmatchedJobs } from './store.js';
import { matchJob, passesEnvFilter, dispatchAlerts, checkJobLiveness } from './notify.js';
import { enrichJobWithSalary } from './salary.js';
import { scoreBatch, companyAwarePriority } from './fit.js';
import { BATCH_WATCHLIST, BATCH_POLLER, KV, GHOST } from './config.js';
import { applyMarylandScore } from './maryland.js';
import { enrichDescriptions } from './enrich.js';

export class BatchPollerDO {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/init' && request.method === 'POST') {
      // Prime the alarm on first init
      const existing = await this.state.storage.getAlarm();
      if (!existing) {
        await this.state.storage.setAlarm(Date.now() + 5_000);
      }
      await this.state.storage.put('started_at', new Date().toISOString());
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/status') {
      const cursor      = (await this.state.storage.get('cursor')) ?? 0;
      const lastRun     = (await this.state.storage.get('last_run')) ?? null;
      const totalPolled = (await this.state.storage.get('total_polled')) ?? 0;
      const totalMatches= (await this.state.storage.get('total_matches')) ?? 0;
      const listLen     = BATCH_WATCHLIST.length;
      const cycleMin    = Math.ceil(listLen / BATCH_POLLER.companies_per_cycle)
                          * (BATCH_POLLER.alarm_interval_ms / 60_000);
      return new Response(JSON.stringify({
        cursor, listLength: listLen, lastRun, totalPolled, totalMatches,
        companiesPerCycle: BATCH_POLLER.companies_per_cycle,
        alarmIntervalMin: BATCH_POLLER.alarm_interval_ms / 60_000,
        fullCycleMinutes: cycleMin,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('Not found', { status: 404 });
  }

  async alarm() {
    // Load cursor and seen IDs
    let cursor = (await this.state.storage.get('cursor')) ?? 0;

    // Load global seen-set
    let seenIds;
    try {
      const raw = await storeGet(getStatStore(this.env), 'seen_ids');
      seenIds = raw ? new Set(JSON.parse(raw)) : new Set();
    } catch (e) { console.warn('[STAT batch] seenIds load failed (dedup may be incomplete):', e.message); seenIds = new Set(); }

    const list  = BATCH_WATCHLIST;
    const chunk = list.slice(cursor, cursor + BATCH_POLLER.companies_per_cycle);
    const newMatches    = [];
    const unmatchedJobs = [];
    let polledCount = 0;

    for (const company of chunk) {
      try {
        const jobs = await fetchCompanyJobs(company);
        polledCount++;

        for (const job of jobs) {
          // Ghost filter
          if (job.daysAgo !== null) {
            if (job.daysAgo > GHOST.suppress_after_days) { job.ghostFlag = 'suppress'; continue; }
            if (job.daysAgo > GHOST.warn_after_days) job.ghostFlag = 'warn';
          }
          if (job.ghostFlag === 'suppress') continue;
          // Browse capture: env-filter BEFORE dedup (same fix as platform-do.js)
          if (passesEnvFilter(job) && !matchJob(job)) {
            unmatchedJobs.push(job);
          }

          // Dedup: alert path only
          if (seenIds.has(job.id)) continue;
          seenIds.add(job.id);

          if (!passesEnvFilter(job)) continue;
          const match = matchJob(job);
          if (!match) continue; // already captured above

          const liveness = await checkJobLiveness(job);
          if (liveness === 'dead') continue;
          job.liveness = liveness;

          await enrichJobWithSalary(job, match, this.env);

          const adjustedPriority = companyAwarePriority(job, match);
          const adjustedMatch = adjustedPriority !== match.priority
            ? { ...match, priority: adjustedPriority } : match;

          job.matchedKeyword = match.matchedKw;
          job._matchGroup    = adjustedMatch.label;
          job._company       = company;

          newMatches.push({ job, match: adjustedMatch });
        }

        // Polite delay between ATS fetches
        await new Promise(r => setTimeout(r, BATCH_POLLER.delay_between_fetches_ms));

      } catch (e) {
        console.warn(`[STAT Batch] ${company.name} error:`, e.message);
      }
    }

    // Advance cursor — wrap around when we reach the end of the list
    const nextCursor = (cursor + BATCH_POLLER.companies_per_cycle) >= list.length
      ? 0
      : cursor + BATCH_POLLER.companies_per_cycle;

    // Persist state
    await this.state.storage.put('cursor', nextCursor);
    await this.state.storage.put('last_run', new Date().toISOString());
    const prevPolled  = (await this.state.storage.get('total_polled'))  ?? 0;
    const prevMatches = (await this.state.storage.get('total_matches')) ?? 0;
    await this.state.storage.put('total_polled',  prevPolled  + polledCount);
    await this.state.storage.put('total_matches', prevMatches + newMatches.length);

    // Save updated seen-set back to KV
    try {
      let arr = Array.from(seenIds);
      if (arr.length > KV.max_seen) arr = arr.slice(-KV.max_seen);
      await storeSet(getStatStore(this.env), 'seen_ids', JSON.stringify(arr));
    } catch (e) {
      console.warn('[STAT Batch] Failed to save seen IDs:', e.message);
    }

    // Second-pass description fetch + MD batch scoring
    if (newMatches.length > 0) {
      await enrichDescriptions(newMatches, this.env);
      const mdFiltered = [];
      for (const m of newMatches) {
        const suppressed = applyMarylandScore(m.job, m.job._company);
        if (!suppressed) mdFiltered.push(m);
        delete m.job._company;
      }
      newMatches.length = 0;
      newMatches.push(...mdFiltered);
    }

    // Score + dispatch
    if (newMatches.length > 0) {
      try {
        const profileRaw = await storeGet(getStatStore(this.env), 'resume_profile');
        const profile = profileRaw ? JSON.parse(profileRaw) : null;
        if (profile && this.env.GEMINI_KEY) {
          await scoreBatch(newMatches, profile, this.env.GEMINI_KEY);
        }
      } catch (e) {
        console.warn('[STAT Batch] Fit scoring skipped:', e.message);
      }
      console.log(`[STAT Batch] cursor=${cursor}: ${newMatches.length} matches from ${polledCount} companies`);
      await dispatchAlerts(this.env, newMatches);
      await saveRecentMatches(getStatStore(this.env), newMatches);
    }

    if (unmatchedJobs.length > 0) {
      await saveUnmatchedJobs(getStatStore(this.env), unmatchedJobs);
    }

    // Reschedule
    await this.state.storage.setAlarm(
      Date.now() + BATCH_POLLER.alarm_interval_ms
    );
  }
}
