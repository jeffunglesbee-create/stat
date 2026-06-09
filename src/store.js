/**
 * STAT — StateStoreDO
 *
 * Single named Durable Object (idFromName: 'global') that replaces
 * all five global KV keys with DO SQLite storage.
 *
 * Migrated from STAT_KV (Workers KV) to DO SQLite:
 *   seen_jobs      → 'seen_ids'       JSON array, max 5000 entries
 *   company_list   → 'company_list'   JSON array of company configs
 *   do_registry    → 'do_registry'    JSON object: token → metadata
 *   match_counts   → 'match_counts'   JSON object: company → count
 *   resume_profile → 'resume_profile' JSON object
 *
 * WHY: KV writes (1M/month included) were the tightest billing constraint
 * at scale. DO SQLite includes 50M rows/month — 50x more headroom.
 * All five keys together generate ~88,668 writes/month from platform DOs,
 * BatchPollerDO, and the Worker cron. Moving to DO SQLite takes this to
 * effectively zero billing cost regardless of company count growth.
 *
 * Access pattern:
 *   const stub = getStatStore(env);
 *   const seenIds = await storeGet(stub, 'seen_ids');
 *   await storeSet(stub, 'seen_ids', JSON.stringify(arr));
 *
 * HTTP API (all requests to 'https://stat-store/'):
 *   GET  /get?key=seen_ids          → { value: '...' } | { value: null }
 *   POST /set?key=seen_ids          body: raw string   → { ok: true }
 *   POST /delete?key=resume_profile                    → { ok: true }
 *   GET  /ping                                         → { ok: true }
 */

export class StateStoreDO {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const key = url.searchParams.get('key');

    try {
      if (url.pathname === '/get') {
        if (!key) return resp({ error: 'key required' }, 400);
        const value = await this.storage.get(key) ?? null;
        return resp({ value });
      }

      if (url.pathname === '/set') {
        if (!key) return resp({ error: 'key required' }, 400);
        const body = await request.text();
        await this.storage.put(key, body);
        return resp({ ok: true });
      }

      if (url.pathname === '/delete') {
        if (!key) return resp({ error: 'key required' }, 400);
        await this.storage.delete(key);
        return resp({ ok: true });
      }

      if (url.pathname === '/ping') {
        return resp({ ok: true });
      }

      return resp({ error: 'unknown route' }, 404);

    } catch (e) {
      return resp({ error: e.message }, 500);
    }
  }
}

function resp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions — use these instead of raw STAT_KV calls
// ─────────────────────────────────────────────────────────────────────────────

/** Get the singleton StateStoreDO stub from env */
export function getStatStore(env) {
  const id = env.STATE_STORE.idFromName('global');
  return env.STATE_STORE.get(id);
}

/** Get a value from StateStoreDO. Returns parsed JSON or null on miss/error. */
export async function storeGet(stub, key) {
  try {
    const res  = await stub.fetch(new Request(`https://stat-store/get?key=${key}`));
    const data = await res.json();
    return data.value ?? null;
  } catch { return null; }
}

/** Set a value in StateStoreDO. Value must be a string (JSON.stringify first). */
export async function storeSet(stub, key, value) {
  try {
    await stub.fetch(new Request(`https://stat-store/set?key=${key}`, {
      method: 'POST',
      body:   value,
    }));
  } catch (e) { console.warn('[STAT store] storeSet failed for key=' + key + ':', e.message); }
}

/** Delete a key from StateStoreDO. */
export async function storeDel(stub, key) {
  try {
    await stub.fetch(new Request(`https://stat-store/delete?key=${key}`, {
      method: 'POST',
    }));
  } catch (e) { console.warn('[STAT store] storeDel failed for key=' + key + ':', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// RECENT MATCHES — rolling store of last 200 keyword-matched jobs
// Saved after every dispatchAlerts() call. Readable at GET /jobs.
// ─────────────────────────────────────────────────────────────────────────────

const RECENT_MATCHES_KEY = 'recent_matches';
const RECENT_MATCHES_MAX = 200;

/**
 * Append new matches to the recent_matches store.
 * Each entry: { job, match, alertedAt }
 * Trims to the last RECENT_MATCHES_MAX entries.
 */
export async function saveRecentMatches(stub, newMatches) {
  if (!newMatches || newMatches.length === 0) return;
  try {
    const raw      = await storeGet(stub, RECENT_MATCHES_KEY);
    const existing = raw ? JSON.parse(raw) : [];
    const alertedAt = new Date().toISOString();
    const toAdd = newMatches.map(({ job, match }) => ({ job, match, alertedAt }));
    const combined = [...toAdd, ...existing];
    // Dedupe by job.id (keep newest)
    const seen = new Set();
    const deduped = combined.filter(({ job }) => {
      if (seen.has(job.id)) return false;
      seen.add(job.id);
      return true;
    });
    const trimmed = deduped.slice(0, RECENT_MATCHES_MAX);
    await storeSet(stub, RECENT_MATCHES_KEY, JSON.stringify(trimmed));
  } catch (e) {
    console.warn('[STAT store] saveRecentMatches failed:', e.message);
  }
}

/** Load all recent matches. Returns array of { job, match, alertedAt }. */
export async function loadRecentMatches(stub) {
  try {
    const raw = await storeGet(stub, RECENT_MATCHES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// UNMATCHED JOBS — env-filtered jobs that passed remote/hybrid check
// but didn't match any keyword. Browsable in the UI without alerting.
// Rolling 500-entry store. No dedup penalty — stored after env filter,
// before keyword match. Keyed 'unmatched_jobs' in StateStoreDO.
// ─────────────────────────────────────────────────────────────────────────────

const UNMATCHED_KEY = 'unmatched_jobs';
const UNMATCHED_MAX = 2000;

/**
 * Append env-filtered non-matching jobs to the unmatched store.
 * @param {object} stub   StateStoreDO stub
 * @param {object[]} jobs Array of normalized job objects
 */
export async function saveUnmatchedJobs(stub, jobs) {
  if (!jobs || jobs.length === 0) return;
  try {
    const raw      = await storeGet(stub, UNMATCHED_KEY);
    const existing = raw ? JSON.parse(raw) : [];
    const seenAt   = new Date().toISOString();
    const toAdd    = jobs.map(job => ({ job, seenAt }));
    const combined = [...toAdd, ...existing];
    // Dedupe by job.id (keep newest)
    const seen = new Set();
    const deduped = combined.filter(({ job }) => {
      if (seen.has(job.id)) return false;
      seen.add(job.id);
      return true;
    });
    await storeSet(stub, UNMATCHED_KEY, JSON.stringify(deduped.slice(0, UNMATCHED_MAX)));
  } catch (e) {
    console.warn('[STAT store] saveUnmatchedJobs failed:', e.message);
  }
}

/** Load unmatched jobs. Returns array of { job, seenAt }. */
export async function loadUnmatchedJobs(stub) {
  try {
    const raw = await storeGet(stub, UNMATCHED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// LOG BUFFER
// Ring buffer of recent Worker log entries stored in StateStoreDO.
// Keyed 'log_buffer'. Max LOG_MAX entries, newest first.
// Entries written by platform DO alarm loops and HC cron.
// Read by GET /logs endpoint and CI log-check workflow.
// ─────────────────────────────────────────────────────────────────────────────

const LOG_KEY = 'log_buffer';
const LOG_MAX = 200;

/**
 * Append a structured log entry to the ring buffer.
 * Non-blocking — failures are silent (never break the main pipeline).
 *
 * @param {object} stub   StateStoreDO stub from getStatStore(env)
 * @param {object} entry  Log entry fields — merged with ts automatically
 */
export async function appendLog(stub, entry) {
  try {
    const raw = await storeGet(stub, LOG_KEY);
    const buf = raw ? JSON.parse(raw) : [];
    buf.unshift({ ts: new Date().toISOString(), ...entry });
    await storeSet(stub, LOG_KEY, JSON.stringify(buf.slice(0, LOG_MAX)));
  } catch { /* never break the pipeline */ }
}

/** Read the log buffer. Returns array of log entries, newest first. */
export async function readLog(stub, limit = LOG_MAX) {
  try {
    const raw = await storeGet(stub, LOG_KEY);
    const buf = raw ? JSON.parse(raw) : [];
    return buf.slice(0, limit);
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPANY LIST, DO REGISTRY, MATCH COUNTS
// Moved from index.js so platform-do.js and batch.js can import them
// without creating a circular dependency with index.js.
// ─────────────────────────────────────────────────────────────────────────────

export async function loadCompanyList(env) {
  try {
    const raw = await storeGet(getStatStore(env), 'company_list');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function saveCompanyList(env, list) {
  await storeSet(getStatStore(env), 'company_list', JSON.stringify(list));
}

export async function loadDoRegistry(env) {
  try {
    const raw = await storeGet(getStatStore(env), 'do_registry');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export async function saveDoRegistry(env, registry) {
  await storeSet(getStatStore(env), 'do_registry', JSON.stringify(registry));
}

export async function loadMatchCounts(env) {
  try {
    const raw = await storeGet(getStatStore(env), 'match_counts');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export async function saveMatchCounts(env, c) {
  await storeSet(getStatStore(env), 'match_counts', JSON.stringify(c));
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-DISCOVERY: maybeAddOrPromoteCompany
//
// Called from both the HiringCafe cron (index.js) AND platform DO alarm loops
// (platform-do.js, batch.js) on every keyword match.
//
// HEALTHCARE GATE: Only promotes companies that look like health systems or
// Epic consulting firms. Prevents "Lightspeed", "IBM", "Deel" etc. from
// polluting the watchlist when they match "epic" in non-EHR context.
//
// gate: 'strict' (default) — require healthcare/consulting name signal
//       'loose'            — any company (use when source is already filtered)
// ─────────────────────────────────────────────────────────────────────────────

const _HC_HINTS = [
  'health', 'hospital', 'medical center', 'medical centre', 'clinic',
  'healthcare', 'medicine', 'physician', 'care center', 'care centre',
  'health system', 'health network', 'health plan', 'health sciences',
  'memorial', 'baptist', 'presbyterian', 'methodist', 'adventist',
  'ascension', 'dignity', 'intermountain', 'providence', 'kaiser',
  'ucsf', 'mayo', 'geisinger', 'sanford', 'vanderbilt', 'atrium',
];
const _CO_HINTS = [
  'consulting', 'consultancy', 'advisors', 'advisory', 'solutions',
  'partners', 'staffing', 'technology', 'technologies', 'services',
  'implement', 'accenture', 'deloitte', 'cognizant', 'optum', 'leidos',
  'nordic', 'guidehouse', 'huron', 'chartis', 'netsmart', 'tegria',
  'divurgent', 'inovalon', 'evolent',
];

function _looksLikeEpicEmployer(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return _HC_HINTS.some(h => n.includes(h)) || _CO_HINTS.some(h => n.includes(h));
}

const _PROMOTE_THRESHOLD = 2;
const _PLATFORM_MAP = {
  greenhouse: 'GREENHOUSE_DO', lever: 'LEVER_DO', ashby: 'ASHBY_DO',
  workday: 'WORKDAY_DO', icims: 'ICIMS_DO',
  successfactors: 'SUCCESSFACTORS_DO', taleo: 'TALEO_DO',
};

export async function maybeAddOrPromoteCompany(env, job, { gate = 'strict', ctx = null } = {}) {
  if (!job.url || !job.company) return;

  // Healthcare gate
  if (gate === 'strict' && !_looksLikeEpicEmployer(job.company)) return;

  let ats = null, token = null;

  // HiringCafe jobs carry structured ATS info in job.hc
  if (job.hc?.atsSource && job.hc.atsSource !== 'hiringcafe' && job.hc?.boardToken) {
    ats   = job.hc.atsSource;
    token = job.hc.boardToken;
  } else {
    try {
      const u = new URL(job.url), h = u.hostname;
      if (h.includes('greenhouse.io'))      { ats = 'greenhouse'; token = u.pathname.split('/')[1]; }
      else if (h.includes('lever.co'))      { ats = 'lever';      token = u.pathname.split('/')[1]; }
      else if (h.includes('ashbyhq.com'))   { ats = 'ashby';      token = u.pathname.split('/')[1]; }
      else if (h.includes('myworkdayjobs')) { ats = 'workday';    token = h.split('.')[0]; }
      else if (h.includes('icims.com'))     { ats = 'icims';      token = h.split('.')[0]; }
      else if (h.includes('taleo.net'))     { ats = 'taleo';      token = h.split('.')[0]; }
    } catch { return; }
  }
  if (!ats || !token) return;

  const doKey = `${ats}:${token}`;
  const now   = Date.now();

  // Use preloaded ctx when available (avoids 4–6 StateStoreDO hops per match).
  // ctx is provided by platform-do alarm() which pre-loads these keys once at alarm start.
  // Callers without ctx (HC cron, jobhive scan) fall back to individual loads — correct,
  // since those paths don't have a pre-loaded context object.
  const counts = ctx?.counts ?? await loadMatchCounts(env);
  if (!counts[doKey]) counts[doKey] = { count: 0, firstSeen: now, lastSeen: now, name: job.company };
  counts[doKey].count++;
  counts[doKey].lastSeen = now;
  if (ctx) { ctx.counts = counts; ctx.dirty.counts = true; }
  else await saveMatchCounts(env, counts);

  // Already promoted — nothing more to do
  const registry = ctx?.registry ?? await loadDoRegistry(env);
  if (registry[doKey]) return;

  // Add to company_list on first sighting
  const companies = ctx ? ctx.companies : (await loadCompanyList(env) ?? []);
  const exists = companies.some(c => c.ats === ats && c.token === token);
  if (!exists) {
    companies.push({ name: job.company, ats, token, url: job.url,
      autoDiscovered: true, firstMatchAt: new Date().toISOString() });
    if (ctx) { ctx.companies = companies; ctx.dirty.companies = true; }
    else await saveCompanyList(env, companies);
    console.log(`[STAT] Auto-discovered: ${job.company} (${ats}:${token})`);
  }

  // Promote once threshold reached
  if (counts[doKey].count >= _PROMOTE_THRESHOLD) {
    if (!_PLATFORM_MAP[ats] || !env[_PLATFORM_MAP[ats]]) return;
    registry[doKey] = {
      name: job.company, ats, autoDiscovered: true, promoted: true,
      promotedAt: new Date().toISOString(), matchCount: counts[doKey].count,
    };
    if (ctx) { ctx.registry = registry; ctx.dirty.registry = true; }
    else await saveDoRegistry(env, registry);
    console.log(`[STAT] Promoted: ${job.company} (${ats}) after ${counts[doKey].count} matches`);
  }
}
