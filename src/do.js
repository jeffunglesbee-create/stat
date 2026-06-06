/**
 * STAT — CompanyWatcherDO
 *
 * One Durable Object instance per target employer.
 * Self-scheduling via DO alarms — no cron dependency.
 * Alarm fires → fetch ATS → compare to KV seen-set → alert on new matches → reschedule.
 *
 * Speed: 30s for Greenhouse/Lever/Ashby, 60s for Workday/iCIMS, 90-120s for others.
 * Crash-resilient: DO alarms survive deploys and restarts (guaranteed at-least-once).
 */

import { fetchCompanyJobs } from './adapters.js';
import { matchJob, passesEnvFilter, dispatchAlerts, checkJobLiveness } from './notify.js';
import { enrichJobWithSalary } from './salary.js';
import { getPollingInterval, KV, GHOST } from './config.js';
import { scoreBatch, companyAwarePriority } from './fit.js';

export class CompanyWatcherDO {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
    // DO storage: company config + per-company seen IDs (separate from global KV)
    this.storage = state.storage;
  }

  // ── Called by the worker to initialize or reconfigure this DO ──────────────
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/init') {
      const company = await request.json();
      await this.storage.put('company', company);
      // Only schedule if not already running
      const existing = await this.storage.getAlarm();
      if (!existing) {
        await this.state.storage.setAlarm(Date.now() + 5_000); // first run in 5s
      }
      return new Response(JSON.stringify({ ok: true, company: company.name }));
    }

    if (url.pathname === '/status') {
      const company  = await this.storage.get('company');
      const lastRun  = await this.storage.get('last_run');
      const seenCount = await this.storage.get('seen_count') ?? 0;
      const nextAlarm = await this.storage.getAlarm();
      return new Response(JSON.stringify({ company: company?.name, lastRun, seenCount, nextAlarm }));
    }

    if (request.method === 'POST' && url.pathname === '/stop') {
      await this.storage.deleteAlarm();
      return new Response(JSON.stringify({ ok: true, stopped: true }));
    }

    return new Response('STAT CompanyWatcherDO', { status: 200 });
  }

  // ── The alarm: fetch → match → alert → reschedule ─────────────────────────
  async alarm() {
    const company = await this.storage.get('company');
    if (!company) return; // orphaned DO — don't reschedule

    let newMatches = [];

    try {
      // 1. Fetch all current jobs from this company's ATS
      const jobs = await fetchCompanyJobs(company);

      // 2. Load this DO's seen-set (per-company, not global)
      const seenRaw = await this.storage.get('seen_ids');
      const seenIds = new Set(seenRaw ?? []);

      // 3. Find genuinely new jobs that match keywords + env filter
      for (const job of jobs) {
        if (seenIds.has(job.id)) continue;
        seenIds.add(job.id);

        // Ghost suppression — if too old, don't alert at all
        if (job.ghostFlag === 'suppress') continue;

        // Environment filter
        if (!passesEnvFilter(job)) continue;

        // Keyword match
        const match = matchJob(job);
        if (!match) continue;

        // Liveness check — HEAD request on job URL before alerting.
        // 'dead' (4xx) → skip + keep in seen-set (job is gone from ATS).
        // 'unknown' (timeout/5xx) → let through with a note, don't suppress.
        // This is the check HiringCafe does NOT do — we confirm the URL is
        // live at the moment the alert fires, not just at last crawl time.
        const liveness = await checkJobLiveness(job);
        if (liveness === 'dead') {
          // URL is 4xx — job was pulled from ATS between our fetch and now.
          // Already added to seenIds above so we won't re-alert it.
          console.log(`[STAT DO] ${company.name}: dead URL suppressed — ${job.title}`);
          continue;
        }
        job.liveness = liveness; // 'live' | 'unknown' — passed through to alert

        // Salary enrichment — peer pool + LCA + BLS + transparency signal.
        // Enriches jobs that lack salary data; records disclosed salaries
        // into the peer pool for future inference.
        // Non-blocking: if the SalaryInferenceDO is unreachable, job still alerts.
        await enrichJobWithSalary(job, match, this.env);

        // Apply company-aware priority: consulting firm Epic matches
        // are downgraded to P2; health system matches stay P1.
        // The fit score can still upgrade consulting matches back to P1
        // if chemistry is strong (handled in effectivePriority).
        const adjustedPriority = companyAwarePriority(job, match);
        const adjustedMatch = adjustedPriority !== match.priority
          ? { ...match, priority: adjustedPriority }
          : match;

        job.matchedKeyword = match.matchedKw;
        job._matchGroup = adjustedMatch.label;
        newMatches.push({ job, match: adjustedMatch });
      }

      // 4. Persist updated seen-set (cap at 500 per company)
      let seenArr = Array.from(seenIds);
      if (seenArr.length > 500) seenArr = seenArr.slice(-500);
      await this.storage.put('seen_ids', seenArr);
      await this.storage.put('seen_count', seenArr.length);
      await this.storage.put('last_run', new Date().toISOString());

      // 5. Also add new job IDs to global KV seen-set
      // (prevents HiringCafe cron from re-alerting on same jobs)
      if (newMatches.length > 0) {
        await this._mergeIntoGlobalSeen(newMatches.map(m => m.job.id));
      }

      // 6. Score against resume profile (if stored), then fire alerts
      if (newMatches.length > 0) {
        try {
          const profileRaw = await this.env.STAT_KV.get(KV.resume_profile);
          const profile = profileRaw ? JSON.parse(profileRaw) : null;
          if (profile && this.env.ANTHROPIC_API_KEY) {
            await scoreBatch(newMatches, profile, this.env.ANTHROPIC_API_KEY);
          }
        } catch (e) { console.warn('[STAT DO] Fit scoring skipped:', e.message); }
        console.log(`[STAT DO] ${company.name}: ${newMatches.length} new matches`);
        await dispatchAlerts(this.env, newMatches);
      }

    } catch (e) {
      console.error(`[STAT DO] ${company.name} poll error:`, e.message);
    }

    // 7. Reschedule — time-aware interval based on ET time of day and day of week.
    // Fastest during Mon–Fri 6–10am ET (peak posting window), slowest overnight
    // and weekends. Cuts alarm writes ~75% vs flat 30s, enabling ~3,300 companies
    // at $25/month while preserving competitive speed when it matters.
    const interval = getPollingInterval(company?.ats ?? 'workday');
    await this.state.storage.setAlarm(Date.now() + interval);
  }

  // ── Merge new IDs into global KV seen-set ─────────────────────────────────
  async _mergeIntoGlobalSeen(newIds) {
    try {
      const raw = await this.env.STAT_KV.get(KV.seen_jobs);
      const existing = raw ? new Set(JSON.parse(raw)) : new Set();
      for (const id of newIds) existing.add(id);
      let arr = Array.from(existing);
      if (arr.length > KV.max_seen) arr = arr.slice(-KV.max_seen);
      await this.env.STAT_KV.put(KV.seen_jobs, JSON.stringify(arr));
    } catch { /* non-critical */ }
  }
}
