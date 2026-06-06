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

// ─────────────────────────────────────────────────────────────────────────────
// SEEN IDs — global KV helpers
// ─────────────────────────────────────────────────────────────────────────────
async function loadSeenIds(kv) {
  try {
    const raw = await kv.get(KV.seen_jobs);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

async function saveSeenIds(kv, seenSet) {
  let arr = Array.from(seenSet);
  if (arr.length > KV.max_seen) arr = arr.slice(-KV.max_seen);
  await kv.put(KV.seen_jobs, JSON.stringify(arr));
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPANY WATCHLIST — KV helpers
// ─────────────────────────────────────────────────────────────────────────────
async function loadCompanyList(kv) {
  try {
    const raw = await kv.get(KV.company_list);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function saveCompanyList(kv, list) {
  await kv.put(KV.company_list, JSON.stringify(list));
}

// ─────────────────────────────────────────────────────────────────────────────
// DO REGISTRY — track which companies have active DOs
// ─────────────────────────────────────────────────────────────────────────────
async function loadDoRegistry(kv) {
  try {
    const raw = await kv.get(KV.do_registry);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

async function saveDoRegistry(kv, registry) {
  await kv.put(KV.do_registry, JSON.stringify(registry));
}

async function loadProfile(kv) {
  try { const r = await kv.get(KV.resume_profile); return r ? JSON.parse(r) : null; }
  catch { return null; }
}
async function saveProfile(kv, p) { await kv.put(KV.resume_profile, JSON.stringify(p)); }

async function loadMatchCounts(kv) {
  try { const r = await kv.get(KV.match_counts); return r ? JSON.parse(r) : {}; }
  catch { return {}; }
}
async function saveMatchCounts(kv, c) { await kv.put(KV.match_counts, JSON.stringify(c)); }

// ─────────────────────────────────────────────────────────────────────────────
// BOOTSTRAP DOs for all companies in the watchlist
// Called on first deploy and when new companies are added.
// ─────────────────────────────────────────────────────────────────────────────
async function bootstrapDOs(env) {
  // Load or initialize company watchlist
  let companies = await loadCompanyList(env.STAT_KV);
  if (!companies) {
    companies = SEED_COMPANIES;
    await saveCompanyList(env.STAT_KV, companies);
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

  const registry = await loadDoRegistry(env.STAT_KV);
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

  if (spawned > 0) await saveDoRegistry(env.STAT_KV, registry);

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
      await saveDoRegistry(env.STAT_KV, registry);
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
  const seenIds = await loadSeenIds(env.STAT_KV);
  const newMatches = [];
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

  await saveSeenIds(env.STAT_KV, seenIds);

  if (newMatches.length > 0) {
    const profile = await loadProfile(env.STAT_KV);
    if (profile && env.ANTHROPIC_API_KEY) {
      await scoreBatch(newMatches, profile, env.ANTHROPIC_API_KEY);
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
  const companies = await loadCompanyList(env.STAT_KV) ?? [];
  const registry  = await loadDoRegistry(env.STAT_KV);
  const counts    = await loadMatchCounts(env.STAT_KV);

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
  await saveMatchCounts(env.STAT_KV, counts);

  // Already have a DO — nothing more to do
  if (registry[doKey]) return;

  // Add to company list on first sighting
  const exists = companies.some(c => c.ats === ats && c.token === token);
  if (!exists) {
    companies.push({ name: job.company, ats, token, url: job.url,
      autoDiscovered: true, firstMatchAt: new Date().toISOString() });
    await saveCompanyList(env.STAT_KV, companies);
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
      await saveDoRegistry(env.STAT_KV, registry);
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
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP HANDLER — operational endpoints
// ─────────────────────────────────────────────────────────────────────────────
async function handleFetch(request, env) {
  const url = new URL(request.url);

  // GET / — system overview
  if (url.pathname === '/') {
    const registry = await loadDoRegistry(env.STAT_KV);
    const seenIds  = await loadSeenIds(env.STAT_KV);
    const companies = await loadCompanyList(env.STAT_KV) ?? [];
    const profile = await loadProfile(env.STAT_KV);
    return json({
      name: 'STAT Job Watcher',
      version: '2.0.0',
      activeDOs: Object.keys(registry).length,
      watchedCompanies: companies.length,
      batchWatchlist: BATCH_WATCHLIST.length,
      totalMonitored: companies.length + BATCH_WATCHLIST.length,
      seenJobIds: seenIds.size,
      resumeProfile: profile ? `${profile.name || 'stored'} · ${profile.headline || ''}` : null,
      fitScoring: profile && env.ANTHROPIC_API_KEY ? 'active' : profile ? 'profile stored — add ANTHROPIC_API_KEY' : 'disabled (no profile stored)',
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
    const companies = await loadCompanyList(env.STAT_KV) ?? SEED_COMPANIES;
    const registry  = await loadDoRegistry(env.STAT_KV);
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
    const companies = await loadCompanyList(env.STAT_KV) ?? [];
    const doKey = `${company.ats}:${company.token ?? company.name}`;
    const exists = companies.some(c => `${c.ats}:${c.token ?? c.name}` === doKey);
    if (exists) return json({ error: 'Company already in watchlist' }, 409);
    companies.push(company);
    await saveCompanyList(env.STAT_KV, companies);
    // Spawn DO immediately
    const id = env.COMPANY_WATCHER.idFromName(doKey);
    const stub = env.COMPANY_WATCHER.get(id);
    await stub.fetch(new Request('https://stat-internal/init', {
      method: 'POST',
      body: JSON.stringify(company),
      headers: { 'Content-Type': 'application/json' },
    }));
    const registry = await loadDoRegistry(env.STAT_KV);
    registry[doKey] = { name: company.name, ats: company.ats, startedAt: new Date().toISOString() };
    await saveDoRegistry(env.STAT_KV, registry);
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

  // GET /profile
  if (url.pathname === '/profile' && request.method === 'GET') {
    const profile = await loadProfile(env.STAT_KV);
    if (!profile) return json({ stored: false });
    return json({ stored: true, profile });
  }

  // POST /profile — store resume profile for fit scoring
  if (url.pathname === '/profile' && request.method === 'POST') {
    let profile;
    try { profile = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    await saveProfile(env.STAT_KV, profile);
    return json({
      ok: true, name: profile.name || '(unnamed)',
      fitScoring: env.ANTHROPIC_API_KEY
        ? 'active — all future alerts will be scored against this profile'
        : 'profile stored but ANTHROPIC_API_KEY not set — run: wrangler secret put ANTHROPIC_API_KEY',
    });
  }

  // DELETE /profile
  if (url.pathname === '/profile' && request.method === 'DELETE') {
    await env.STAT_KV.delete(KV.resume_profile);
    return json({ ok: true, message: 'Profile removed. Fit scoring disabled.' });
  }

  // GET /learning — auto-discovered companies + promotion status
  if (url.pathname === '/learning' && request.method === 'GET') {
    const counts   = await loadMatchCounts(env.STAT_KV);
    const registry = await loadDoRegistry(env.STAT_KV);
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
    await env.STAT_KV.put(KV.seen_jobs, JSON.stringify([]));
    return json({ ok: true, message: 'Seen IDs cleared — next run will re-alert all current jobs' });
  }

  // POST /reset-all — nuclear reset
  if (url.pathname === '/reset-all' && request.method === 'POST') {
    await env.STAT_KV.put(KV.seen_jobs, JSON.stringify([]));
    await env.STAT_KV.put(KV.do_registry, JSON.stringify({}));
    await env.STAT_KV.put(KV.match_counts, JSON.stringify({}));
    await env.STAT_KV.delete(KV.company_list);
    return json({ ok: true, message: 'Full reset — POST /bootstrap to re-initialize all platform DOs' });
  }

  // ── GET /br-test?url={url}&ats={ats} ──────────────────────────────────────
  // Browser Rendering diagnostic endpoint.
  // Runs headless Chromium against any URL, waits for JS to execute,
  // then extracts: og:description, page title, job links, DOM text excerpt.
  // Used to verify Browser Rendering works against iCIMS/Taleo SPAs and
  // to harvest real job URLs from their rendered DOM for further testing.
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
