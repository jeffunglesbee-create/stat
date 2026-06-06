/**
 * STAT — Main Worker
 *
 * Entry points:
 *   scheduled()  — 1-min cron: HiringCafe wide-net scrape + DO health
 *   fetch()      — HTTP endpoints: /status /trigger /reset /companies /stop
 *
 * Architecture:
 *   Tier 1 (fast, ~30-120s): CompanyWatcherDO per employer — direct ATS polling
 *   Tier 2 (wide-net, 1min): Cron-driven HiringCafe scrape + unknown-company catch
 *
 * FIELD infrastructure lessons applied:
 *   - DO alarm pattern from FIELD GameDO / ATP Mitigation doc
 *   - KV dedup from FIELD score store pattern
 *   - Relay-is-dumb: this worker fetches facts, caller decides relevance
 *   - No intelligence in the Worker itself — all matching in config + notify
 */

export { SalaryInferenceDO } from './salary.js';
export { BatchPollerDO } from './batch.js';
export {
  GreenhouseDO, LeverDO, AshbyDO, WorkdayDO,
  IcimsDO, SuccessFactorsDO, TaleoDO,
} from './platform-do.js';

import { SEED_COMPANIES, BATCH_WATCHLIST, KV, HIRINGCAFE, BATCH_POLLER } from './config.js';
import { bootstrapSalaryDO } from './salary.js';
import { fetchHiringCafe } from './adapters.js';
import { matchJob, passesEnvFilter, dispatchAlerts } from './notify.js';
import { scoreBatch, companyAwarePriority } from './fit.js';
import puppeteer from '@cloudflare/puppeteer';
import { getStatStore, storeGet, storeSet, storeDel, saveRecentMatches, loadRecentMatches, loadUnmatchedJobs, saveUnmatchedJobs } from './store.js';
export { StateStoreDO } from './store.js';
import UI_HTML from './ui.html';

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL STATE — DO SQLite helpers (via StateStoreDO)
// All five previously-KV keys now live in StateStoreDO SQLite storage.
// Helpers accept env and derive the stub internally for a clean call site.
// ─────────────────────────────────────────────────────────────────────────────
async function loadSeenIds(env) {
  try {
    const raw = await storeGet(getStatStore(env), 'seen_ids');
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

async function saveSeenIds(env, seenSet) {
  let arr = Array.from(seenSet);
  if (arr.length > KV.max_seen) arr = arr.slice(-KV.max_seen);
  await storeSet(getStatStore(env), 'seen_ids', JSON.stringify(arr));
}

async function loadCompanyList(env) {
  try {
    const raw = await storeGet(getStatStore(env), 'company_list');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function saveCompanyList(env, list) {
  await storeSet(getStatStore(env), 'company_list', JSON.stringify(list));
}

async function loadDoRegistry(env) {
  try {
    const raw = await storeGet(getStatStore(env), 'do_registry');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

async function saveDoRegistry(env, registry) {
  await storeSet(getStatStore(env), 'do_registry', JSON.stringify(registry));
}

async function loadProfile(env) {
  try {
    const raw = await storeGet(getStatStore(env), 'resume_profile');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
async function saveProfile(env, p) {
  await storeSet(getStatStore(env), 'resume_profile', JSON.stringify(p));
}

async function loadMatchCounts(env) {
  try {
    const raw = await storeGet(getStatStore(env), 'match_counts');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
async function saveMatchCounts(env, c) {
  await storeSet(getStatStore(env), 'match_counts', JSON.stringify(c));
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOTSTRAP DOs for all companies in the watchlist
// Called on first deploy and when new companies are added.
// ─────────────────────────────────────────────────────────────────────────────
async function bootstrapDOs(env) {
  // Load or initialize company watchlist
  let companies = await loadCompanyList(env);
  if (!companies) {
    companies = SEED_COMPANIES;
    await saveCompanyList(env, companies);
  }

  // Platform DO map: binding name → ATS key
  const PLATFORM_DOS = [
    { binding: 'GREENHOUSE_DO',     ats: 'greenhouse' },
    { binding: 'LEVER_DO',          ats: 'lever' },
    { binding: 'ASHBY_DO',          ats: 'ashby' },
    { binding: 'WORKDAY_DO',        ats: 'workday' },
    { binding: 'ICIMS_DO',          ats: 'icims' },
    { binding: 'SUCCESSFACTORS_DO', ats: 'successfactors' },
    { binding: 'TALEO_DO',          ats: 'taleo' },
  ];

  const registry = await loadDoRegistry(env);
  let spawned = 0;

  for (const { binding, ats } of PLATFORM_DOS) {
    const key = `platform:${ats}`;
    if (registry[key]) continue; // already running
    const doBinding = env[binding];
    if (!doBinding) continue;
    try {
      const id   = doBinding.idFromName(ats);
      const stub = doBinding.get(id);
      await stub.fetch(new Request('https://stat-internal/init', { method: 'POST' }));
      const count = companies.filter(c => c.ats === ats).length;
      registry[key] = {
        name: `${ats} platform DO`, ats, type: 'platform',
        companyCount: count, startedAt: new Date().toISOString(),
      };
      spawned++;
      console.log(`[STAT] ${ats} platform DO started (${count} companies)`);
    } catch (e) {
      console.error(`[STAT] Failed to start ${ats} DO:`, e.message);
    }
  }

  if (spawned > 0) await saveDoRegistry(env, registry);

  // Bootstrap SalaryInferenceDO
  if (spawned > 0 || Object.keys(registry).filter(k => k.startsWith('platform:')).length === 0) {
    try {
      const r = await bootstrapSalaryDO(env);
      console.log('[STAT] Salary bootstrap:', JSON.stringify(r));
    } catch (e) {
      console.warn('[STAT] Salary bootstrap failed (non-critical):', e.message);
    }
  }

  // Bootstrap BatchPollerDO
  if (!registry['batch:main'] && BATCH_WATCHLIST.length > 0) {
    try {
      const id   = env.BATCH_POLLER.idFromName('batch-main');
      const stub = env.BATCH_POLLER.get(id);
      await stub.fetch(new Request('https://stat-internal/init', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ list: 'batch_watchlist' }),
      }));
      registry['batch:main'] = {
        name: 'BatchPollerDO', type: 'batch',
        listSize: BATCH_WATCHLIST.length, startedAt: new Date().toISOString(),
      };
      await saveDoRegistry(env, registry);
      console.log(`[STAT] BatchPollerDO started — ${BATCH_WATCHLIST.length} companies`);
    } catch (e) {
      console.warn('[STAT] BatchPollerDO bootstrap failed (non-critical):', e.message);
    }
  }

  return { companies, registry, spawned };
}


// ─────────────────────────────────────────────────────────────────────────────
// HIRINGCAFE WIDE-NET SCRAPE
// Catches employers not in the DO watchlist.
// On a new company match, adds them to the watchlist and spawns a DO.
// ─────────────────────────────────────────────────────────────────────────────
async function runHiringCafeScrape(env) {
  const seenIds = await loadSeenIds(env);
  const newMatches = [];
  const unmatchedJobsHC = [];  // env-filtered HC jobs with no keyword match — Browse capture
  const seenThisRun = new Set();

  for (const term of HIRINGCAFE.search_terms) {
    for (const envType of HIRINGCAFE.environments) {
      const jobs = await fetchHiringCafe(term, envType);
      for (const job of jobs) {
        if (seenThisRun.has(job.id) || seenIds.has(job.id)) {
          seenIds.add(job.id);
          seenThisRun.add(job.id);
          continue;
        }
        seenThisRun.add(job.id);
        seenIds.add(job.id);

        if (job.ghostFlag === 'suppress') continue;
        // Browse capture for HiringCafe path (Rule 8 — all paths capture unmatched)
        if (passesEnvFilter(job) && !matchJob(job)) {
          unmatchedJobsHC.push(job);
        }
        if (!passesEnvFilter(job)) continue;
        const match = matchJob(job);
        if (!match) continue;

        job.matchedKeyword = match.matchedKw;
        const adjustedPriority = companyAwarePriority(job, match);
        const adjustedMatch = adjustedPriority !== match.priority
          ? { ...match, priority: adjustedPriority }
          : match;
        job._matchGroup = adjustedMatch.label;
        newMatches.push({ job, match: adjustedMatch });

        await maybeAddOrPromoteCompany(env, job);
      }
      await new Promise(r => setTimeout(r, 400));
    }
  }

  await saveSeenIds(env, seenIds);

  if (unmatchedJobsHC.length > 0) {
    await saveUnmatchedJobs(getStatStore(env), unmatchedJobsHC);
  }

  if (newMatches.length > 0) {
    const profile = await loadProfile(env);
    if (profile && env.GEMINI_KEY) {
      await scoreBatch(newMatches, profile, env.GEMINI_KEY);
    }
    console.log(`[STAT HC] ${newMatches.length} new HiringCafe matches`);
    await dispatchAlerts(env, newMatches);
  }

  return newMatches.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-DISCOVER + PROMOTE
// First match: track company in match_counts KV.
// After LEARNING.promote_after_matches matches: spawn a persistent DO.
// This makes the watchlist self-building — high-signal employers graduate
// from wide-net tracking to 30-second direct ATS polling automatically.
// ─────────────────────────────────────────────────────────────────────────────
async function maybeAddOrPromoteCompany(env, job) {
  if (!job.url || !job.company) return;
  const companies = await loadCompanyList(env) ?? [];
  const registry  = await loadDoRegistry(env);
  const counts    = await loadMatchCounts(env);

  let ats = null, token = null;

  // HiringCafe jobs carry structured ATS info in job.hc — use it first
  if (job.hc?.atsSource && job.hc.atsSource !== 'hiringcafe' && job.hc?.boardToken) {
    ats   = job.hc.atsSource;
    token = job.hc.boardToken;
  } else {
    // Fall back to URL parsing for non-HiringCafe or missing hc data
    try {
      const u = new URL(job.url), h = u.hostname;
      if (h.includes('greenhouse.io') || h.includes('boards.greenhouse')) {
        ats = 'greenhouse'; token = u.pathname.split('/')[1] || h.split('.')[0];
      } else if (h.includes('lever.co')) {
        ats = 'lever'; token = u.pathname.split('/')[1];
      } else if (h.includes('ashbyhq.com')) {
        ats = 'ashby'; token = u.pathname.split('/')[1];
      } else if (h.includes('myworkdayjobs.com')) {
        ats = 'workday'; token = h.split('.')[0];
      } else if (h.includes('icims.com')) {
        ats = 'icims'; token = h.split('.')[0].replace('careers-', '').replace('careers', '');
      }
    } catch { return; }
  }
  if (!ats || !token) return;

  const doKey = `${ats}:${token}`;
  const now = Date.now();

  // Track match count
  if (!counts[doKey]) counts[doKey] = { count: 0, firstSeen: now, lastSeen: now, name: job.company };
  counts[doKey].count++;
  counts[doKey].lastSeen = now;
  await saveMatchCounts(env, counts);

  // Already have a DO — nothing more to do
  if (registry[doKey]) return;

  // Add to company list on first sighting
  const exists = companies.some(c => c.ats === ats && c.token === token);
  if (!exists) {
    companies.push({ name: job.company, ats, token, url: job.url,
      autoDiscovered: true, firstMatchAt: new Date().toISOString() });
    await saveCompanyList(env, companies);
    console.log(`[STAT] Tracking: ${job.company} (${ats}) — match #1`);
  }

  // Promote to DO if threshold reached
  const recentCount = counts[doKey].count;
  if (recentCount >= LEARNING.promote_after_matches) {
    const company = companies.find(c => c.ats === ats && c.token === token);
    if (!company) return;
    const id = env.COMPANY_WATCHER.idFromName(doKey);
    const stub = env.COMPANY_WATCHER.get(id);
    try {
      await stub.fetch(new Request('https://stat-internal/init', {
        method: 'POST', body: JSON.stringify(company),
        headers: { 'Content-Type': 'application/json' },
      }));
      registry[doKey] = { name: company.name, ats, autoDiscovered: true, promoted: true,
        promotedAt: new Date().toISOString(), matchCount: recentCount };
      await saveDoRegistry(env, registry);
      console.log(`[STAT] Promoted: ${company.name} (${ats}) after ${recentCount} matches`);
    } catch (e) {
      console.error(`[STAT] Promotion failed for ${company.name}:`, e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CRON HANDLER — runs every minute
// 1. Bootstrap DOs if not already running
// 2. Run HiringCafe wide-net scrape
// ─────────────────────────────────────────────────────────────────────────────
async function handleScheduled(env) {
  // Bootstrap DOs (idempotent — skips already-running companies)
  await bootstrapDOs(env);
  // Wide-net HiringCafe scrape
  await runHiringCafeScrape(env);
  // Auto-refresh salary caches on schedule — no manual intervention required
  await maybeRefreshSalaryCaches(env);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO SALARY CACHE REFRESH
// Runs every cron tick but only refreshes when caches are stale.
// LCA: quarterly (90 days) — DOL releases new data every quarter
// BLS: annual (365 days) — BLS OEWS publishes in May each year
// Both refreshes are non-blocking — a failure never blocks the cron cycle.
// ─────────────────────────────────────────────────────────────────────────────
async function maybeRefreshSalaryCaches(env) {
  try {
    const id   = env.SALARY_INFERENCE.idFromName('salary-inference');
    const stub = env.SALARY_INFERENCE.get(id);

    const statusRes = await stub.fetch(new Request('https://stat-salary/status'));
    const { blsDate, lcaDate } = await statusRes.json();

    const now         = Date.now();
    const BLS_TTL_MS  = 365 * 24 * 60 * 60 * 1000; // 1 year
    const LCA_TTL_MS  =  90 * 24 * 60 * 60 * 1000; // 90 days (quarterly)

    const blsStale = !blsDate || (now - new Date(blsDate).getTime()) > BLS_TTL_MS;
    const lcaStale = !lcaDate || (now - new Date(lcaDate).getTime()) > LCA_TTL_MS;

    if (blsStale) {
      console.log('[STAT cron] BLS cache stale — refreshing');
      stub.fetch(new Request('https://stat-salary/refresh-bls', { method: 'POST' }))
        .catch(e => console.warn('[STAT cron] BLS refresh error:', e.message));
    }

    if (lcaStale) {
      console.log('[STAT cron] LCA cache stale — refreshing');
      stub.fetch(new Request('https://stat-salary/refresh-lca', { method: 'POST' }))
        .catch(e => console.warn('[STAT cron] LCA refresh error:', e.message));
    }
  } catch (e) {
    // Non-critical — salary DO may not be bootstrapped yet
    console.warn('[STAT cron] Salary cache check skipped:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP HANDLER — operational endpoints
// ─────────────────────────────────────────────────────────────────────────────
async function handleFetch(request, env) {
  const url = new URL(request.url);

  // GET /ui — HTML dashboard (served inline from ui.html)
  if (url.pathname === '/ui' && request.method === 'GET') {
    return new Response(UI_HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // GET / — redirect browsers to /ui, return JSON for API clients
  if (url.pathname === '/' && request.method === 'GET') {
    const accept = request.headers.get('Accept') || '';
    if (accept.includes('text/html')) {
      return Response.redirect(new URL('/ui', request.url).toString(), 302);
    }
    const registry = await loadDoRegistry(env);
    const seenIds  = await loadSeenIds(env);
    const companies = await loadCompanyList(env) ?? [];
    const profile = await loadProfile(env);

    // Fetch salary cache status non-blocking (failure just means no salary data yet)
    let salaryStatus = { peerCount: 0, lcaCount: 0, blsDate: null, lcaDate: null };
    try {
      const salId = env.SALARY_INFERENCE.idFromName('salary-inference');
      const salStub = env.SALARY_INFERENCE.get(salId);
      const salRes = await salStub.fetch(new Request('https://stat-salary/status'));
      salaryStatus = await salRes.json();
    } catch { /* not yet bootstrapped */ }

    const now = Date.now();
    const blsAge = salaryStatus.blsDate
      ? Math.floor((now - new Date(salaryStatus.blsDate).getTime()) / 86_400_000) + 'd'
      : 'never';
    const lcaAge = salaryStatus.lcaDate
      ? Math.floor((now - new Date(salaryStatus.lcaDate).getTime()) / 86_400_000) + 'd'
      : 'never';

    return json({
      name: 'STAT Job Watcher',
      version: '2.0.0',
      activeDOs: Object.keys(registry).length,
      watchedCompanies: companies.length,
      batchWatchlist: BATCH_WATCHLIST.length,
      totalMonitored: companies.length + BATCH_WATCHLIST.length,
      seenJobIds: seenIds.size,
      resumeProfile: profile ? `${profile.name || 'stored'} · ${profile.headline || ''}` : null,
      fitScoring: profile && env.GEMINI_KEY ? 'active' : profile ? 'profile stored — add ANTHROPIC_API_KEY' : 'disabled (no profile stored)',
      salary: {
        peers: salaryStatus.peerCount,
        lcaRecords: salaryStatus.lcaCount,
        blsCacheAge: blsAge,
        lcaCacheAge: lcaAge,
        status: salaryStatus.lcaCount > 0 && salaryStatus.blsDate
          ? 'active' : salaryStatus.lcaCount > 0
          ? 'bls-pending' : 'cold-start',
      },
      endpoints: {
        'GET /':               'This status overview',
        'POST /trigger':       'Run HiringCafe scrape now',
        'POST /bootstrap':     'Spawn DOs for all companies',
        'GET /companies':      'List all watched companies',
        'POST /companies':     'Add a company (body: {name,ats,token,url?})',
        'GET /platform/:ats/status': 'Status of a platform DO (greenhouse/lever/etc.)',
        'GET /salary-status':  'Salary DO status',
        'POST /salary-refresh':'Re-fetch salary caches',
        'GET /profile':        'Get stored resume profile',
        'POST /profile':       'Store resume profile (JSON from resume-matcher)',
        'DELETE /profile':     'Remove stored profile',
        'GET /learning':       'Auto-discovered companies + promotion status',
        'GET /batch-status':   'BatchPollerDO cycle status + cursor position',
        'GET /br-test?url=&ats=': 'Browser Rendering diagnostic — test against iCIMS/Taleo SPAs',
        'POST /reset-seen':    'Clear seen job IDs',
        'POST /reset-all':     'Nuclear reset',
      },
    });
  }

  // POST /trigger — manual HiringCafe scrape
  if (url.pathname === '/trigger' && request.method === 'POST') {
    const count = await runHiringCafeScrape(env);
    return json({ ok: true, newMatches: count, time: new Date().toISOString() });
  }

  // POST /bootstrap — manually spawn all DOs
  if (url.pathname === '/bootstrap' && request.method === 'POST') {
    const result = await bootstrapDOs(env);
    return json({ ok: true, spawned: result.spawned, total: result.companies.length });
  }

  // GET /salary-status — salary inference DO status
  if (url.pathname === '/salary-status' && request.method === 'GET') {
    try {
      const id = env.SALARY_INFERENCE.idFromName('salary-inference');
      const stub = env.SALARY_INFERENCE.get(id);
      const res = await stub.fetch(new Request('https://stat-salary/status'));
      return res;
    } catch (e) {
      return json({ error: 'SALARY_INFERENCE not available: ' + e.message });
    }
  }

  // POST /salary-refresh — manually refresh BLS + LCA caches
  if (url.pathname === '/salary-refresh' && request.method === 'POST') {
    try {
      const result = await bootstrapSalaryDO(env);
      return json({ ok: true, ...result });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  // GET /companies — list watchlist with platform DO status
  if (url.pathname === '/companies' && request.method === 'GET') {
    const companies = await loadCompanyList(env) ?? SEED_COMPANIES;
    const registry  = await loadDoRegistry(env);
    // Group by ATS platform
    const byPlatform = {};
    for (const c of companies) {
      if (!byPlatform[c.ats]) byPlatform[c.ats] = [];
      byPlatform[c.ats].push(c);
    }
    return json({
      total: companies.length,
      batchWatchlist: BATCH_WATCHLIST.length,
      totalMonitored: companies.length + BATCH_WATCHLIST.length,
      platforms: Object.entries(byPlatform).map(([ats, cos]) => ({
        ats,
        count: cos.length,
        doActive: !!registry[`platform:${ats}`],
        companies: cos.map(c => c.name),
      })),
    });
  }

  // POST /companies — add a company to the watchlist
  if (url.pathname === '/companies' && request.method === 'POST') {
    const company = await request.json();
    if (!company.name || !company.ats) {
      return json({ error: 'name and ats are required' }, 400);
    }
    const companies = await loadCompanyList(env) ?? [];
    const doKey = `${company.ats}:${company.token ?? company.name}`;
    const exists = companies.some(c => `${c.ats}:${c.token ?? c.name}` === doKey);
    if (exists) return json({ error: 'Company already in watchlist' }, 409);
    companies.push(company);
    await saveCompanyList(env, companies);
    // Spawn DO immediately
    const id = env.COMPANY_WATCHER.idFromName(doKey);
    const stub = env.COMPANY_WATCHER.get(id);
    await stub.fetch(new Request('https://stat-internal/init', {
      method: 'POST',
      body: JSON.stringify(company),
      headers: { 'Content-Type': 'application/json' },
    }));
    const registry = await loadDoRegistry(env);
    registry[doKey] = { name: company.name, ats: company.ats, startedAt: new Date().toISOString() };
    await saveDoRegistry(env, registry);
    return json({ ok: true, company: company.name, doKey });
  }

  // GET /platform/:ats/status — check a platform DO (e.g. /platform/greenhouse/status)
  if (url.pathname.startsWith('/platform/') && request.method === 'GET') {
    const ats = url.pathname.split('/')[2]?.replace('/status', '');
    const PLATFORM_MAP = {
      greenhouse: 'GREENHOUSE_DO', lever: 'LEVER_DO', ashby: 'ASHBY_DO',
      workday: 'WORKDAY_DO', icims: 'ICIMS_DO',
      successfactors: 'SUCCESSFACTORS_DO', taleo: 'TALEO_DO',
    };
    const binding = PLATFORM_MAP[ats];
    if (!binding || !env[binding]) return json({ error: `Unknown platform: ${ats}` }, 404);
    const id   = env[binding].idFromName(ats);
    const stub = env[binding].get(id);
    const res  = await stub.fetch(new Request('https://stat-internal/status'));
    return res;
  }

  // GET /batch-status — BatchPollerDO status
  if (url.pathname === '/batch-status' && request.method === 'GET') {
    try {
      const id   = env.BATCH_POLLER.idFromName('batch-main');
      const stub = env.BATCH_POLLER.get(id);
      const res  = await stub.fetch(new Request('https://stat-internal/status'));
      return res;
    } catch (e) {
      return json({ error: 'BatchPollerDO not available: ' + e.message });
    }
  }

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

  // GET /browse — env-filtered jobs that didn't match any keyword
  // Useful for manually spotting roles STAT missed. ?ats= ?q= ?limit=
  if (url.pathname === '/browse' && request.method === 'GET') {
    const items = await loadUnmatchedJobs(getStatStore(env));
    let filtered = items;

    const qAts    = url.searchParams.get('ats');
    const qSearch = url.searchParams.get('q')?.toLowerCase();
    const qLimit  = parseInt(url.searchParams.get('limit') || '200', 10);

    if (qAts)    filtered = filtered.filter(m => m.job?.atsSource === qAts);
    if (qSearch) filtered = filtered.filter(m =>
      (m.job?.title || '').toLowerCase().includes(qSearch) ||
      (m.job?.company || '').toLowerCase().includes(qSearch)
    );

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
      const raw = await storeGet(getStatStore(env), 'seen_ids');
      globalSeen = raw ? new Set(JSON.parse(raw)) : new Set();
    } catch (e) { console.warn('[STAT backfill] globalSeen load failed (dedup may be incomplete):', e.message); globalSeen = new Set(); }

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
            if (!globalSeen.has(job.id)) {
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

  // GET /profile
  if (url.pathname === '/profile' && request.method === 'GET') {
    const profile = await loadProfile(env);
    if (!profile) return json({ stored: false });
    return json({ stored: true, profile });
  }

  // POST /score-job — score a job description against a stored profile via Gemini
  // Called by ui.html Resume tab "Score This Job". Keeps API keys server-side.
  if (url.pathname === '/score-job' && request.method === 'POST') {
    if (!env.GEMINI_KEY) return json({ error: 'GEMINI_KEY not configured' }, 503);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const { profile, jd } = body;
    if (!profile || !jd) return json({ error: 'profile and jd required' }, 400);

    const systemPrompt = `You are a senior healthcare IT career advisor specializing in Epic EHR roles.
Score this candidate profile against the job description. Return ONLY valid JSON:
{
  "score": number 1-10,
  "verdict": "2-4 word verdict",
  "strengths": ["top 3 match points"],
  "gaps": ["top 2-3 gaps"],
  "salaryNote": "brief salary alignment note or null",
  "coverOpener": "2-sentence job-specific cover letter opener. Must reference the specific role and company."
}`;
    const userText = 'CANDIDATE PROFILE:\n' + JSON.stringify(profile, null, 2) + '\n\nJOB DESCRIPTION:\n' + jd.slice(0, 4000);

    try {
      const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + env.GEMINI_KEY;
      const geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userText }] }],
          generationConfig: { maxOutputTokens: 600, temperature: 0.2 },
        }),
      });
      const geminiData = await geminiRes.json();
      const raw = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const cleaned = raw.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
      const result = JSON.parse(cleaned);
      return json({ ok: true, result });
    } catch (e) {
      return json({ error: 'Scoring failed: ' + e.message }, 500);
    }
  }

  // POST /extract-profile — extract structured profile from raw resume text via Gemini
  // Called by ui.html Resume tab. Keeps API keys server-side.
  if (url.pathname === '/extract-profile' && request.method === 'POST') {
    if (!env.GEMINI_KEY) return json({ error: 'GEMINI_KEY not configured' }, 503);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const resumeText = (body.text || '').slice(0, 8000);
    if (!resumeText) return json({ error: 'No text provided' }, 400);

    const systemPrompt = `You are a healthcare IT hiring specialist with deep knowledge of Epic EHR implementations.
Extract the candidate profile as JSON with EXACTLY these fields (use empty arrays/null if not present):
{
  "headline": "2-3 word professional summary",
  "yearsExperience": number or null,
  "epicModules": ["array of Epic module names"],
  "otherSystems": ["other EHR/HIT systems"],
  "certifications": ["Epic and other certs"],
  "skills": ["top 6 technical skills"],
  "targetRoles": ["appropriate job titles"],
  "environments": ["remote","hybrid","onsite"],
  "matchStrengths": ["3 strongest selling points"],
  "potentialGaps": ["2-3 areas that may be missing"]
}
Return ONLY the JSON object, no markdown, no explanation.`;

    try {
      const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + env.GEMINI_KEY;
      const geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: resumeText }] }],
          generationConfig: { maxOutputTokens: 800, temperature: 0.1 },
        }),
      });
      const geminiData = await geminiRes.json();
      const raw = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const cleaned = raw.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
      const profile = JSON.parse(cleaned);
      return json({ ok: true, profile });
    } catch (e) {
      return json({ error: 'Extraction failed: ' + e.message }, 500);
    }
  }

  // POST /profile — store resume profile for fit scoring
  if (url.pathname === '/profile' && request.method === 'POST') {
    let profile;
    try { profile = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    await saveProfile(env, profile);
    return json({
      ok: true, name: profile.name || '(unnamed)',
      fitScoring: env.GEMINI_KEY
        ? 'active — all future alerts will be scored against this profile'
        : 'profile stored but ANTHROPIC_API_KEY not set — run: wrangler secret put ANTHROPIC_API_KEY',
    });
  }

  // DELETE /profile
  if (url.pathname === '/profile' && request.method === 'DELETE') {
    await storeDel(getStatStore(env), 'resume_profile');
    return json({ ok: true, message: 'Profile removed. Fit scoring disabled.' });
  }

  // GET /learning — auto-discovered companies + promotion status
  if (url.pathname === '/learning' && request.method === 'GET') {
    const counts   = await loadMatchCounts(env);
    const registry = await loadDoRegistry(env);
    const entries  = Object.entries(counts)
      .map(([key, v]) => ({
        key, name: v.name, matchCount: v.count,
        promoted: !!registry[key]?.promoted,
        watching: !!registry[key],
        lastSeen: v.lastSeen ? new Date(v.lastSeen).toISOString() : null,
      }))
      .sort((a, b) => b.matchCount - a.matchCount);
    return json({
      total: entries.length,
      promoted: entries.filter(e => e.promoted).length,
      companies: entries,
    });
  }

  // POST /reset-seen — clear global seen IDs
  if (url.pathname === '/reset-seen' && request.method === 'POST') {
    await storeSet(getStatStore(env), 'seen_ids', JSON.stringify([]));
    return json({ ok: true, message: 'Seen IDs cleared — next run will re-alert all current jobs' });
  }

  // POST /reset-all — nuclear reset
  if (url.pathname === '/reset-all' && request.method === 'POST') {
    await storeSet(getStatStore(env), 'seen_ids', JSON.stringify([]));
    await storeSet(getStatStore(env), 'do_registry', JSON.stringify({}));
    await storeSet(getStatStore(env), 'match_counts', JSON.stringify({}));
    await storeDel(getStatStore(env), 'company_list');
    return json({ ok: true, message: 'Full reset — POST /bootstrap to re-initialize all platform DOs' });
  }

  // ── GET /br-test?url={url}&ats={ats} ──────────────────────────────────────
  // Browser Rendering diagnostic endpoint.
  // Runs headless Chromium against any URL, waits for JS to execute,
  // then extracts: og:description, page title, job links, DOM text excerpt.
  // Used to verify Browser Rendering works against iCIMS/Taleo SPAs and
  // to harvest real job URLs from their rendered DOM for further testing.
  // ── GET /harvest — discover new companies from HiringCafe ─────────────────
  // Runs fetchHiringCafe() across all WATCH_GROUPS keywords and environments.
  // Returns company+ATS pairs not already in the current company watchlist.
  // Used by CI harvest workflow to bulk-discover new companies.
  // Worker IP is not blocked by HiringCafe (proven — 1-min cron works).
  if (url.pathname === '/harvest' && request.method === 'GET') {
    const HARVEST_TERMS = [
      'epic analyst', 'epic ambulatory', 'epic application analyst',
      'ehr analyst', 'ehr application analyst', 'clarity sql',
      'epic implementation', 'epic consultant', 'epic inpatient',
      'epic reporting', 'epic cogito', 'epic caboodle',
      'epic within', 'epic cadence', 'epic mychart',
      'epic optime', 'epic beacon', 'epic radiant', 'epic willow', 'epic resolute',
      'clinical informatics analyst', 'healthcare it analyst',
      'health informatics analyst', 'epic training analyst',
      'epic build analyst', 'epic go live',
      'cerner analyst', 'meditech analyst',
      'health information management', 'revenue cycle analyst',
      'remote customer service', 'remote customer success',
      'remote logistics coordinator', 'remote supply chain analyst',
      'remote data analyst', 'remote sql analyst',
    ];
    const ENVS = ['remote', 'hybrid'];

    // Load current company list for dedup
    const knownCompanies = await loadCompanyList(env) ?? SEED_COMPANIES;
    const knownNames  = new Set(knownCompanies.map(c => c.name.toLowerCase().trim()));
    const knownTokens = new Set(knownCompanies.filter(c => c.token).map(c => c.token.toLowerCase()));
    const knownUrls   = new Set(knownCompanies.filter(c => c.url).map(c => c.url.toLowerCase()));

    const discovered = new Map(); // key: ats:token → {company, ats, token, hits}
    const allSeenCompanies = []; // for debug mode
    let totalCalls = 0;

    for (const term of HARVEST_TERMS) {
      for (const envType of ENVS) {
        try {
          const jobs = await fetchHiringCafe(term, envType);
          totalCalls++;
          for (const job of jobs) {
            const company  = (job.company || '').trim();
            const atsSource = job.hc?.atsSource || job.atsSource || '';
            const token    = job.hc?.boardToken || '';
            const applyUrl = job.url || '';

            if (!company || company.length < 3) continue;
            if (atsSource && SUPPORTED.includes(atsSource)) {
              allSeenCompanies.push({company, ats: atsSource, known: knownNames.has(company.toLowerCase())});
            }
            if (knownNames.has(company.toLowerCase())) continue;

            // Determine ATS and canonical token/url
            const SUPPORTED = ['greenhouse','lever','ashby','workday','icims','successfactors','taleo'];
            if (!SUPPORTED.includes(atsSource)) continue;

            const tokenVal = token || (atsSource === 'workday' ? applyUrl : '');
            if (!tokenVal || tokenVal.length < 3) continue;
            if (knownTokens.has(tokenVal.toLowerCase())) continue;
            if (knownUrls.has(tokenVal.toLowerCase())) continue;

            const key = atsSource + ':' + tokenVal.toLowerCase();
            if (!discovered.has(key)) {
              discovered.set(key, { company, ats: atsSource, token: tokenVal, hits: 0 });
            }
            discovered.get(key).hits++;
          }
        } catch (e) {
          console.warn('[STAT harvest]', term, envType, e.message);
        }
        // Small delay to be polite
        await new Promise(r => setTimeout(r, 300));
      }
    }

    const results = [...discovered.values()].sort((a, b) =>
      a.ats.localeCompare(b.ats) || a.company.localeCompare(b.company)
    );

    // Summary by ATS
    const byAts = {};
    for (const r of results) {
      if (!byAts[r.ats]) byAts[r.ats] = [];
      byAts[r.ats].push(r.company);
    }

    const debug = url.searchParams.get('debug') === '1';
    const allSeen = debug ? allSeenCompanies : undefined;

    return json({
      ok: true,
      total_calls: totalCalls,
      count: results.length,
      by_ats: Object.fromEntries(Object.entries(byAts).map(([k,v]) => [k, v.length])),
      companies: results,
      ...(debug ? { all_seen_count: allSeenCompanies.length, all_seen: allSeenCompanies.slice(0,50) } : {}),
    });
  }


  // ── GET /plain-fetch-test?url={url} ───────────────────────────────────────
  // Plain Worker fetch() diagnostic — no headless browser.
  // Tests whether Cloudflare Worker IPs are blocked by a given URL.
  // Returns HTTP status, response size, og:description, page title,
  // any job IDs found in href patterns, and a body text excerpt.
  //
  // Critical use: verifying iCIMS in_iframe=1 endpoints are reachable
  // from inside a Worker (Cloudflare IP) without Browser Rendering.
  //
  // Usage:
  //   /plain-fetch-test?url=https://careers-vhchealth.icims.com/jobs/search%3Fss%3D1%26in_iframe%3D1
  //
  if (url.pathname === '/plain-fetch-test' && request.method === 'GET') {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) return json({ error: 'url param required' }, 400);

    const t0 = Date.now();
    try {
      const res = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control':   'no-cache',
        },
        redirect: 'follow',
      });

      const elapsed   = Date.now() - t0;
      const body      = await res.text();
      const bodyLen   = body.length;

      // Extract og:description
      const ogMatch = body.match(/<meta[^>]*(?:property|name)="og:description"[^>]*content="([^"]{10,})"[^>]*>/i)
                   || body.match(/<meta[^>]*content="([^"]{10,})"[^>]*(?:property|name)="og:description"[^>]*>/i);
      const ogDesc  = ogMatch?.[1] ?? '';

      // Page title
      const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title      = titleMatch?.[1]?.trim() ?? '';

      // Job IDs from href patterns — iCIMS: /jobs/{id}/
      const jobIdMatches = [...body.matchAll(/\/jobs\/(\d{4,6})\//g)];
      const jobIds = [...new Set(jobIdMatches.map(m => m[1]))].slice(0, 20);

      // Job hrefs
      const hrefMatches = [...body.matchAll(/href="(\/jobs\/\d+\/[^"?]+)"/g)];
      const jobHrefs = [...new Set(hrefMatches.map(m => m[1]))].slice(0, 10);

      // Body text excerpt (strip tags)
      const bodyText = body
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);

      // Blocked indicators
      const isBlocked = res.status === 403
        || title.includes('403')
        || title.includes('Forbidden')
        || title.includes('Access Denied');

      return json({
        ok:          !isBlocked && res.status < 400,
        url:         targetUrl,
        http_status: res.status,
        elapsed_ms:  elapsed,
        body_bytes:  bodyLen,
        is_blocked:  isBlocked,
        title,
        og_description:   ogDesc.slice(0, 300),
        job_ids:          jobIds,
        job_hrefs:        jobHrefs,
        body_text_excerpt: bodyText.slice(0, 300),
      });

    } catch (e) {
      return json({
        ok:        false,
        url:       targetUrl,
        elapsed_ms: Date.now() - t0,
        error:     e.message,
      }, 500);
    }
  }

  //
  // Usage:
  //   curl "https://stat-job-watcher.*.workers.dev/br-test?url=https://careers-vhchealth.icims.com/jobs/search&ats=icims"
  //
  if (url.pathname === '/br-test' && request.method === 'GET') {
    const targetUrl = url.searchParams.get('url');
    const ats       = url.searchParams.get('ats') ?? 'unknown';
    if (!targetUrl) return json({ error: 'url param required' }, 400);
    if (!env.MYBROWSER) return json({ error: 'MYBROWSER binding not available' }, 500);

    const t0 = Date.now();
    let browser = null;
    try {
      // Try session reuse first
      const sessions = await puppeteer.sessions(env.MYBROWSER);
      const idle = sessions.filter(s => !s.connectionId);
      if (idle.length > 0) {
        try { browser = await puppeteer.connect(env.MYBROWSER, idle[0].sessionId); } catch {}
      }
      if (!browser) browser = await puppeteer.launch(env.MYBROWSER);

      const page = await browser.newPage();

      // Suppress heavy resources to speed up SPA load
      await page.setRequestInterception(true);
      page.on('request', req => {
        const t = req.resourceType();
        if (['image', 'font', 'media', 'stylesheet'].includes(t)) req.abort();
        else req.continue();
      });

      await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 20_000 });

      // Extract everything useful from the rendered DOM
      const extracted = await page.evaluate(() => {
        // og:description or meta description
        const og = document.querySelector(
          'meta[property="og:description"], meta[name="og:description"], meta[name="description"]'
        );
        const ogDesc = og?.content ?? '';

        // Page title
        const title = document.title ?? '';

        // All job-like links (iCIMS: /jobs/{id}/..., Taleo: jobdetail.ftl?job=...)
        const allLinks = [...document.querySelectorAll('a[href]')]
          .map(a => a.href)
          .filter(h => h && (
            h.includes('/jobs/') ||
            h.includes('jobdetail') ||
            h.includes('jobId=') ||
            h.includes('job=') ||
            h.includes('requisition')
          ))
          .slice(0, 20);

        // Visible text from likely job containers
        const jobText = [...document.querySelectorAll(
          '[class*="job"], [class*="position"], [class*="listing"], ' +
          '[id*="job"], [id*="search-results"], main, article'
        )]
          .map(el => el.innerText?.trim())
          .filter(t => t && t.length > 30)
          .slice(0, 3)
          .join('\n---\n');

        // DOM text excerpt from body (first 1000 chars of visible text)
        const bodyText = document.body?.innerText?.trim().slice(0, 1000) ?? '';

        // Count of elements that look like job cards
        const cardCount = document.querySelectorAll(
          '[class*="job-card"], [class*="job_card"], [class*="jobCard"], ' +
          '[class*="result-item"], [class*="posting"]'
        ).length;

        return { ogDesc, title, allLinks, jobText, bodyText, cardCount };
      });

      await page.close();
      await browser.disconnect();

      const elapsed = Date.now() - t0;
      return json({
        ok:       true,
        ats,
        url:      targetUrl,
        elapsed_ms: elapsed,
        title:    extracted.title,
        og_description: extracted.ogDesc,
        job_links: extracted.allLinks,
        job_card_count: extracted.cardCount,
        dom_text_excerpt: extracted.bodyText.slice(0, 500),
        job_container_text: extracted.jobText.slice(0, 500),
      });

    } catch (e) {
      if (browser) { try { await browser.close(); } catch {} }
      return json({ ok: false, ats, url: targetUrl, error: e.message, elapsed_ms: Date.now() - t0 }, 500);
    }
  }

  return json({ error: 'Not found' }, 404);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKER EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
  async fetch(request, env, ctx) {
    return handleFetch(request, env);
  },
};
