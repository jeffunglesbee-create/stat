import { json } from './_utils.js';
import { SEED_COMPANIES, GHOST } from '../config.js';
import {
  getStatStore, storeSet,
  loadRecentMatches, loadUnmatchedJobs, saveUnmatchedJobs,
} from '../store.js';
import { matchJob, passesEnvFilter } from '../notify.js';
import { enrichDescriptions } from '../enrich.js';
import { fetchCompanyJobs } from '../adapters.js';
import {
  loadSeenIds, loadCompanyList, checkSeenStatus,
} from '../state.js';

export async function handleJobs(request, url, env) {
  // GET /jobs — recent keyword-matched jobs (rolling 200)
  // Query params: ?priority=1 ?ats=greenhouse ?q=epic ?limit=50
  if (url.pathname === '/jobs' && request.method === 'GET') {
    const matches = await loadRecentMatches(getStatStore(env));
    let filtered = matches;

    const qPriority = url.searchParams.get('priority');
    const qAts      = url.searchParams.get('ats');
    const qSearch   = url.searchParams.get('q')?.toLowerCase();
    const qLimit    = parseInt(url.searchParams.get('limit') || '200', 10);

    if (qPriority) filtered = filtered.filter(m => String(m.match?.priority) === qPriority);
    if (qAts)      filtered = filtered.filter(m => m.job?.atsSource === qAts);
    if (qSearch)   filtered = filtered.filter(m =>
      (m.job?.title || '').toLowerCase().includes(qSearch) ||
      (m.job?.company || '').toLowerCase().includes(qSearch) ||
      (m.job?.description || '').toLowerCase().includes(qSearch)
    );

    filtered = filtered.slice(0, Math.min(qLimit, 200));

    return json({
      ok:    true,
      count: filtered.length,
      total: matches.length,
      jobs:  filtered,
    });
  }

  // POST /feedback — record user action on a matched job
  // Body: { jobId, action } where action is 'applied' | 'skip'
  // Writes feedback back into the matching recent_matches entry.
  // Used by the scoring layer to learn from actual user behavior.
  if (url.pathname === '/feedback' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const { jobId, action } = body;
    if (!jobId || !['applied', 'skip'].includes(action)) {
      return json({ error: 'jobId and action (applied|skip) required' }, 400);
    }

    const stub    = getStatStore(env);
    const matches = await loadRecentMatches(stub);
    const idx     = matches.findIndex(m => m.job?.id === jobId);
    if (idx === -1) return json({ error: 'Job not found' }, 404);

    // Write feedback into the match entry
    matches[idx].feedback   = action;
    matches[idx].feedbackAt = new Date().toISOString();

    // Persist
    try {
      await storeSet(stub, 'recent_matches', JSON.stringify(matches));
    } catch (e) {
      return json({ error: 'Store write failed: ' + e.message }, 500);
    }

    console.log(`[STAT feedback] ${action}: ${matches[idx].job?.title} @ ${matches[idx].job?.company}`);
    return json({ ok: true, jobId, action });
  }

  // GET /feedback/summary — recent feedback for scorer context
  // Returns last 50 feedback signals: title, company, action, fitScore
  if (url.pathname === '/feedback/summary' && request.method === 'GET') {
    const matches = await loadRecentMatches(getStatStore(env));
    const signals = matches
      .filter(m => m.feedback)
      .map(m => ({
        title:     m.job?.title || '',
        company:   m.job?.company || '',
        action:    m.feedback,
        fitScore:  m.job?.fitScore ?? null,
        environment: m.job?.environment || '',
        salary:    m.job?.salary || '',
        feedbackAt: m.feedbackAt,
      }))
      .slice(0, 50);
    return json({ ok: true, count: signals.length, signals });
  }

  // POST /dispatch-apply — trigger apply-agent GitHub Actions workflow
  // Body: { url, jobId, dryRun? }
  // Requires STAT_PAT Worker secret (same PAT used for CI).
  if (url.pathname === '/dispatch-apply' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const { url: jobUrl, jobId, dryRun = true } = body;
    if (!jobUrl) return json({ error: 'url required' }, 400);

    if (!env.STAT_PAT) {
      return json({ error: 'STAT_PAT not configured — run: wrangler secret put STAT_PAT' }, 500);
    }

    // Dispatch via GitHub Actions API
    try {
      const ghRes = await fetch(
        'https://api.github.com/repos/jeffunglesbee-create/stat/actions/workflows/apply-agent.yml/dispatches',
        {
          method: 'POST',
          headers: {
            'Authorization': `token ${env.STAT_PAT}`,
            'Accept':        'application/vnd.github.v3+json',
            'User-Agent':    'STAT-Worker',
          },
          body: JSON.stringify({
            ref: 'main',
            inputs: {
              job_url: jobUrl,
              dry_run: dryRun ? 'true' : 'false',
            },
          }),
        }
      );

      if (ghRes.status === 204) {
        console.log(`[STAT apply] dispatched: ${jobId} → ${jobUrl} (dry=${dryRun})`);
        return json({ ok: true, jobId, dispatched: true });
      } else {
        const errText = await ghRes.text();
        console.error(`[STAT apply] dispatch failed ${ghRes.status}: ${errText}`);
        return json({ error: `GitHub API ${ghRes.status}`, detail: errText }, 502);
      }
    } catch (e) {
      console.error('[STAT apply] dispatch error:', e.message);
      return json({ error: 'Dispatch failed: ' + e.message }, 500);
    }
  }

  // GET /browse — env-filtered jobs that didn't match any keyword
  // Useful for manually spotting roles STAT missed. ?ats= ?q= ?limit=
  if (url.pathname === '/browse' && request.method === 'GET') {
    const items = await loadUnmatchedJobs(getStatStore(env));
    let filtered = items;

    const qAts    = url.searchParams.get('ats');
    const qSearch = url.searchParams.get('q')?.toLowerCase();
    const qLimit  = parseInt(url.searchParams.get('limit') || '200', 10);

    if (qAts)    filtered = filtered.filter(m => m.job?.atsSource === qAts);
    if (qSearch) filtered = filtered.filter(m => {
      const q = qSearch;
      return (m.job?.title       || '').toLowerCase().includes(q) ||
             (m.job?.company     || '').toLowerCase().includes(q) ||
             (m.job?.description || '').toLowerCase().includes(q) ||
             (m.job?.atsSource   || '').toLowerCase().includes(q);
    });

    filtered = filtered.slice(0, Math.min(qLimit, 500));

    return json({
      ok:    true,
      count: filtered.length,
      total: items.length,
      jobs:  filtered,
    });
  }

  // POST /backfill-browse — RECOVERY ONLY (Rule 11).
  // Originally created because Browse capture was after the dedup gate (bug).
  // That bug is fixed in platform-do.js + batch.js (2026-06-06, f56188c).
  // Browse now auto-populates on every alarm cycle. This endpoint is retained
  // as a recovery tool if the store is manually cleared or needs priming.
  // Do NOT build automation on top of this — the alarm loop is the primary path.
  // Safe to run multiple times — saveUnmatchedJobs dedupes by job.id.
  if (url.pathname === '/backfill-browse' && request.method === 'POST') {
    const companies = await loadCompanyList(env) ?? SEED_COMPANIES;
    const unmatchedJobs = [];
    let polled = 0;
    let errors = 0;

    // Load global seen set so we know what's already matched
    // NOTE: migrated from STAT_KV to StateStoreDO (store.js migration 2026-06-06)
    let globalSeen;
    try {
      globalSeen = await loadSeenIds(env); // Map<id, entry>
    } catch (e) { console.warn('[STAT backfill] globalSeen load failed (dedup may be incomplete):', e.message); globalSeen = new Map(); }

    for (const company of companies) {
      try {
        const jobs = await fetchCompanyJobs(company);
        polled++;
        for (const job of jobs) {
          // Ghost filter — canonical order per Rule 8 (must match alarm loop)
          if (job.daysAgo !== null && job.daysAgo > GHOST.suppress_after_days) continue;
          if (job.ghostFlag === 'suppress') continue;
          if (!passesEnvFilter(job)) continue;
          const match = matchJob(job);
          if (!match) {
            // Only add if NOT already a matched job (don't mix stores)
            if (!checkSeenStatus(globalSeen, job.id)) {
              unmatchedJobs.push(job);
            }
          }
        }
        // Polite delay
        await new Promise(r => setTimeout(r, 150));
      } catch(e) {
        errors++;
      }
    }

    if (unmatchedJobs.length > 0) {
      await saveUnmatchedJobs(getStatStore(env), unmatchedJobs);
    }

    return json({
      ok: true,
      companies_polled: polled,
      unmatched_found: unmatchedJobs.length,
      errors,
      message: 'Browse store populated. Reload /browse to see results.',
    });
  }

  // GET /description/:jobId — full job description from R2 cache
  // Populated by enrichDescriptions() at alert time. Served on card expand.
  // Falls back to empty string if description was never fetched for this job.
  // Cache-Control: max-age=3600
  // Serves description stored by enrichDescriptions() at job alert time.
  // UI calls this on card expand instead of embedding desc in StateStoreDO payload.
  // Keeps recent_matches + unmatched_jobs payloads lean (no description field).
  if (url.pathname.startsWith('/description/') && request.method === 'GET') {
    const jobId = decodeURIComponent(url.pathname.slice('/description/'.length));
    if (!jobId) return json({ error: 'missing jobId' }, 400);
    if (!env.STAT_R2) return json({ error: 'R2 not bound' }, 503);
    try {
      const obj = await env.STAT_R2.get(`desc/${jobId}`);
      if (!obj) return json({ description: '' });
      const description = await obj.text();
      return new Response(JSON.stringify({ description }), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'max-age=3600' /* descriptions immutable */,  // descriptions are immutable once written
        },
      });
    } catch (e) {
      return json({ error: 'R2 read failed', detail: e.message }, 500);
    }
  }


  return null;
}
