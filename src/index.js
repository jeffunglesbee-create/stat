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

export { CompanyWatcherDO } from './do.js';
export { SalaryInferenceDO } from './salary.js';

import { SEED_COMPANIES, KV, HIRINGCAFE, POLL_INTERVALS, LEARNING } from './config.js';
import { bootstrapSalaryDO } from './salary.js';
import { fetchHiringCafe } from './adapters.js';
import { matchJob, passesEnvFilter, dispatchAlerts } from './notify.js';
import { scoreBatch, companyAwarePriority } from './fit.js';

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
  // Load or initialize company watchlist from seed
  let companies = await loadCompanyList(env.STAT_KV);
  if (!companies) {
    companies = SEED_COMPANIES;
    await saveCompanyList(env.STAT_KV, companies);
    console.log(`[STAT] Initialized watchlist with ${companies.length} seed companies`);
  }

  const registry = await loadDoRegistry(env.STAT_KV);
  let spawned = 0;

  for (const company of companies) {
    const doKey = `${company.ats}:${company.token ?? company.name}`;
    if (registry[doKey]) continue; // already running

    // Spawn a new DO for this company
    const id = env.COMPANY_WATCHER.idFromName(doKey);
    const stub = env.COMPANY_WATCHER.get(id);
    try {
      await stub.fetch(new Request('https://stat-internal/init', {
        method: 'POST',
        body: JSON.stringify(company),
        headers: { 'Content-Type': 'application/json' },
      }));
      registry[doKey] = { name: company.name, ats: company.ats, startedAt: new Date().toISOString() };
      spawned++;
    } catch (e) {
      console.error(`[STAT] Failed to spawn DO for ${company.name}:`, e.message);
    }
  }

  if (spawned > 0) {
    await saveDoRegistry(env.STAT_KV, registry);
    console.log(`[STAT] Spawned ${spawned} new DOs`);
  }

  // Bootstrap SalaryInferenceDO — prime BLS + LCA caches on first deploy
  if (spawned > 0 || Object.keys(registry).length === 0) {
    try {
      const r = await bootstrapSalaryDO(env);
      console.log('[STAT] Salary bootstrap:', JSON.stringify(r));
    } catch (e) {
      console.warn('[STAT] Salary bootstrap failed (non-critical):', e.message);
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
      seenJobIds: seenIds.size,
      resumeProfile: profile ? `${profile.name || 'stored'} · ${profile.headline || ''}` : null,
      fitScoring: profile && env.ANTHROPIC_API_KEY ? 'active' : profile ? 'profile stored — add ANTHROPIC_API_KEY' : 'disabled (no profile stored)',
      endpoints: {
        'GET /':               'This status overview',
        'POST /trigger':       'Run HiringCafe scrape now',
        'POST /bootstrap':     'Spawn DOs for all companies',
        'GET /companies':      'List all watched companies',
        'POST /companies':     'Add a company (body: {name,ats,token,url?})',
        'GET /do/:key/status': 'Status of a specific DO',
        'GET /salary-status':  'Salary DO status',
        'POST /salary-refresh':'Re-fetch salary caches',
        'GET /profile':        'Get stored resume profile',
        'POST /profile':       'Store resume profile (JSON from resume-matcher)',
        'DELETE /profile':     'Remove stored profile',
        'GET /learning':       'Auto-discovered companies + promotion status',
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

  // GET /companies — list watchlist
  if (url.pathname === '/companies' && request.method === 'GET') {
    const companies = await loadCompanyList(env.STAT_KV) ?? SEED_COMPANIES;
    const registry  = await loadDoRegistry(env.STAT_KV);
    return json({
      total: companies.length,
      companies: companies.map(c => ({
        ...c,
        watching: !!registry[`${c.ats}:${c.token ?? c.name}`],
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

  // GET /do/:key/status — check a specific DO
  if (url.pathname.startsWith('/do/') && request.method === 'GET') {
    const doKey = decodeURIComponent(url.pathname.slice(4).replace('/status', ''));
    const id   = env.COMPANY_WATCHER.idFromName(doKey);
    const stub = env.COMPANY_WATCHER.get(id);
    const res  = await stub.fetch(new Request('https://stat-internal/status'));
    return res;
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
    await env.STAT_KV.delete(KV.company_list);
    return json({ ok: true, message: 'Full reset complete — POST /bootstrap to re-initialize' });
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
