#!/usr/bin/env node
/**
 * STAT smoke.js — structural assertions.
 * Blocks commits if critical wiring is broken.
 * Usage: node smoke.js
 */

const fs   = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');

function read(file) {
  return fs.readFileSync(path.join(SRC, file), 'utf8');
}

const results = [];
function assert(name, condition) {
  results.push({ name, ok: !!condition });
}

// ─── platform-do.js ──────────────────────────────────────────────────────────
const pdo = read('platform-do.js');

// Browse capture must appear before dedup gate
const unmatchedPushPos = pdo.indexOf('unmatchedJobs.push(job)');
const dedupPos         = pdo.indexOf('globalSeen.has(job.id)');
assert('platform-do: Browse captures all env-filtered jobs before dedup gate',
  unmatchedPushPos !== -1 && dedupPos !== -1 && unmatchedPushPos < dedupPos);

assert('platform-do: saveUnmatchedJobs called in alarm loop',
  pdo.includes('await saveUnmatchedJobs('));

assert('platform-do: saveUnmatchedJobs imported from store',
  pdo.includes('saveUnmatchedJobs') && pdo.includes("from './store.js'"));

// ─── batch.js ────────────────────────────────────────────────────────────────
const batch = read('batch.js');

const batchUnmatchedPos = batch.indexOf('unmatchedJobs.push(job)');
const batchDedupPos     = batch.indexOf('seenIds.has(job.id)');
assert('batch: Browse captures all env-filtered jobs before dedup gate',
  batchUnmatchedPos !== -1 && batchDedupPos !== -1 && batchUnmatchedPos < batchDedupPos);

assert('batch: saveUnmatchedJobs called after loop',
  batch.includes('await saveUnmatchedJobs('));

// ─── index.js ────────────────────────────────────────────────────────────────
const idx = read('index.js');

assert("index: /browse endpoint present",
  idx.includes("pathname === '/browse'"));

assert('index: loadUnmatchedJobs imported',
  idx.includes('loadUnmatchedJobs'));

assert('index: loadUnmatchedJobs called in handler',
  idx.includes('await loadUnmatchedJobs('));

assert("index: /backfill-browse endpoint present",
  idx.includes("pathname === '/backfill-browse'"));

// ─── ui.html ─────────────────────────────────────────────────────────────────
const ui = read('ui.html');

assert('ui: loadBrowse function defined',
  ui.includes('async function loadBrowse('));

assert('ui: loadBrowse called on tab switch (not only on refresh btn)',
  ui.includes("dataset.tab === 'browse'") && ui.includes('loadBrowse()'));

assert('ui: Refresh button wired to loadBrowse',
  ui.includes("btn-refresh-browse") && ui.includes('loadBrowse'));

assert('ui: browse-list element present',
  ui.includes('id="browse-list"'));

assert('ui: api /browse called in loadBrowse',
  ui.includes("api('/browse"));

// ─── store.js ────────────────────────────────────────────────────────────────
const store = read('store.js');

assert('store: saveUnmatchedJobs exported',
  store.includes('export async function saveUnmatchedJobs('));

assert('store: loadUnmatchedJobs exported',
  store.includes('export async function loadUnmatchedJobs('));

assert('store: UNMATCHED_MAX cap defined',
  store.includes('UNMATCHED_MAX'));
assert('store: UNMATCHED_MAX >= 4000',
  store.includes('UNMATCHED_MAX = 6000'));
assert('ui: browse desc button calls toggleDescBrowse',
  ui.includes("toggleDescBrowse('${job.id}'"));
assert('ui: browse desc button uses data-desc attr',
  ui.includes('data-desc='));
assert('adapters: SF description cleaned via descRaw',
  read('adapters.js').includes('descRaw'));
assert('index: maybeRunJobhiveScan defined', read('index.js').includes('function maybeRunJobhiveScan'));
assert('index: maybeRunJobhiveScan called in cron', read('index.js').includes('await maybeRunJobhiveScan(env)'));
assert('index: /jobhive-scan endpoint present', read('index.js').includes("pathname === '/jobhive-scan'"));
assert('index: JOBHIVE_EPIC_TERMS defined with module names', read('index.js').includes('JOBHIVE_EPIC_TERMS') && read('index.js').includes('epic ambulatory'));
assert('index: matchesEpicTerms searches title and description', read('index.js').includes('matchesEpicTerms(haystack)'));
assert('index: splitCSVRows quote-aware parser defined', read('index.js').includes('function splitCSVRows'));
assert('index: carryInQuote threaded across chunks', read('index.js').includes('carryInQuote'));
assert('index: parseCSVRow defined', read('index.js').includes('function parseCSVRow'));
assert('index: cleanDesc defined', read('index.js').includes('function cleanDesc'));

// ─── JS syntax: no escaped backticks ─────────────────────────────────────────
// Escaped backticks (\`) inside JS source are never valid — they appear when
// Python string escaping bleeds into template literals, producing a syntax
// error that crashes the entire Worker on every request (CF error 1101).
// This check catches the failure mode before CI runs wrangler deploy.

function countEscapedBackticks(src) {
  // Count \` sequences that are NOT inside a string literal comment
  // Simple heuristic: any \` in JS source is wrong
  const matches = src.match(/\\`/g);
  return matches ? matches.length : 0;
}

const indexSrc = read('index.js');
assert('index.js: no escaped backticks (would cause Worker 1101 crash)',
  countEscapedBackticks(indexSrc) === 0);

const enrichSrc = read('enrich.js');
assert('enrich.js: no escaped backticks',
  countEscapedBackticks(enrichSrc) === 0);

const adaptersSrc = read('adapters.js');
assert('adapters.js: no escaped backticks',
  countEscapedBackticks(adaptersSrc) === 0);

// ─── JS syntax check on ui.html script block ────────────────────────────────
// A single syntax error in the <script> block silently kills the entire UI —
// loadStatus(), tab switching, all event listeners. node --check catches it
// before it reaches CI. (Discovered: literal \n in regex = SyntaxError.)
const { execSync } = require('child_process');
try {
  const uiContent = read('ui.html');
  const scriptMatch = uiContent.match(/<script>([\s\S]*?)<\/script>/);
  if (scriptMatch) {
    const fs = require('fs');
    fs.writeFileSync('/tmp/_stat_smoke_ui.js', scriptMatch[1]);
    execSync('node --check /tmp/_stat_smoke_ui.js', { stdio: 'pipe' });
    assert('ui.html: script block has valid JS syntax', true);
  } else {
    assert('ui.html: script block found', false);
  }
} catch (e) {
  assert('ui.html: script block has valid JS syntax — ' + e.message.split('\n').slice(0,2).join(' '), false);
}

// ─── Workday plain HTML GET (2026-06-08 — BR retired) ────────────────────────
// fetchWorkday now uses plain HTML GET with ?q=epic for server-side filtering.
// BR + XHR intercept + DataImpulse proxy all retired after confirmed SSR path.
const platformSrc = read('platform-do.js');
assert('adapters: fetchWorkday signature accepts env param',
  adaptersSrc.includes('async function fetchWorkday(company, env)'));
assert('adapters: fetchWorkday uses ?q=epic server-side filter',
  adaptersSrc.includes('?q=epic') && adaptersSrc.includes('JOBS FOUND'));
assert('adapters: fetchWorkday paginates via startIndex',
  adaptersSrc.includes('startIndex='));
assert('adapters: fetchWorkday parses req IDs from job links',
  adaptersSrc.includes('_(R[A-Z0-9]+)'));
assert('adapters: fetchCompanyJobs passes env to fetchWorkday',
  adaptersSrc.includes('return fetchWorkday(company, env)'));
assert('platform-do: _fetchJobs passes this.env to fetchWorkday',
  platformSrc.includes('return fetchWorkday(company, this.env)'));

// ─── /logs endpoint wiring ───────────────────────────────────────────────────
assert('adapters: mapHiringCafeHit exported', read('adapters.js').includes('export function mapHiringCafeHit'));
assert('index: mapHiringCafeHit imported', read('index.js').includes('mapHiringCafeHit'));
assert('index: HC uses searchState SSR — fetchHiringCafe called in cron', read('index.js').includes('fetchHiringCafe(activeTerm, envType)'));
assert('store: appendLog exported', read('store.js').includes('export async function appendLog'));
assert('store: readLog exported', read('store.js').includes('export async function readLog'));
assert('index: readLog imported', read('index.js').includes('readLog'));
assert('index: /logs endpoint present', read('index.js').includes("pathname === '/logs'"));
assert('index: /detect-ats endpoint present', read('index.js').includes("pathname === '/detect-ats'"));
assert('notify: passesEnvFilter has geo gate', read('notify.js').includes('isNonUsLocation'));
assert('notify: NON_US_COUNTRIES list defined', read('notify.js').includes('NON_US_COUNTRIES'));
assert('notify: NON_US_ISO set defined', read('notify.js').includes('NON_US_ISO'));
assert('store: maybeAddOrPromoteCompany exported', read('store.js').includes('export async function maybeAddOrPromoteCompany'));
assert('store: healthcare gate in maybeAddOrPromoteCompany', read('store.js').includes('_looksLikeEpicEmployer'));
assert('platform-do: maybeAddOrPromoteCompany imported from store', read('platform-do.js').includes('maybeAddOrPromoteCompany'));
assert('platform-do: maybeAddOrPromoteCompany called after match', read('platform-do.js').includes("maybeAddOrPromoteCompany(this.env, job"));
assert('platform-do: maybeAddOrPromoteCompany passes ctx', read('platform-do.js').includes('ctx: promoCtx'));
assert('platform-do: alarm-start reads parallelized', read('platform-do.js').includes("Promise.all([\n        storeGet(store, 'company_list')"));
assert('platform-do: promoCtx dirty flush after job loop', read('platform-do.js').includes('promoCtx.dirty.counts'));
assert('platform-do: total_polled and total_matches reads parallelized', read('platform-do.js').includes("Promise.all([\n      this.storage.get('total_polled')"));
assert('store: maybeAddOrPromoteCompany accepts ctx param', read('store.js').includes('{ gate = \'strict\', ctx = null }'));
assert('store: maybeAddOrPromoteCompany uses ctx.counts when available', read('store.js').includes('ctx?.counts ?? await loadMatchCounts'));
assert('store: maybeAddOrPromoteCompany sets dirty flag', read('store.js').includes('ctx.dirty.counts = true'));
assert('batch: maybeAddOrPromoteCompany called after match', read('batch.js').includes("maybeAddOrPromoteCompany(this.env, job"));
assert('index: detectAts function defined', read('index.js').includes('function detectAts(rawUrl)'));
assert('ui: detect-ats URL field present', read('ui.html').includes('f-url-detect'));
assert('ui: btn-detect handler wired', read('ui.html').includes("'/detect-ats'"));
assert('platform-do: appendLog imported', read('platform-do.js').includes('appendLog'));
assert('platform-do: appendLog called in alarm loop', read('platform-do.js').includes('await appendLog('));
assert('platform-do: appendLog outside unmatchedJobs block (brace fix)',
  read('platform-do.js').includes("saveUnmatchedJobs(getStatStore(this.env), browseForStore);\n    }\n\n    // \u2500\u2500 Structured log entry"));
assert('platform-do: brLog declared in alarm loop', read('platform-do.js').includes('const brLog'));
assert('platform-do: brLog captures workday _source', read('platform-do.js').includes('jobs._source'));
assert('adapters: fetchWorkday tags result with log', adaptersSrc.includes('Workday-SSR plain fetch') || adaptersSrc.includes('[STAT Workday]'));
assert('adapters: fetchWorkday stops at empty pages', adaptersSrc.includes('links.length < 20'));
assert('adapters: fetchSelectMinds exported', adaptersSrc.includes('export async function fetchSelectMinds'));
assert('adapters: fetchSelectMinds uses sequential ID walk', adaptersSrc.includes('SELECTMINDS_SCAN_WINDOW'));
assert('adapters: fetchSelectMinds skips closed jobs', adaptersSrc.includes('position has been closed'));
assert('adapters: fetchSelectMinds wraps cursor at MAX_ID', adaptersSrc.includes('SELECTMINDS_MIN_ID'));
assert('adapters: fetchSelectMinds uses effectiveStart in loop', adaptersSrc.includes('for (let id = effectiveStart'));
assert('adapters: fetchSelectMinds attaches _nextCursor', adaptersSrc.includes('_nextCursor'));
assert('adapters: fetchSelectMinds accepts cursor param', adaptersSrc.includes('selectmindsCursor = null'));
assert('platform-do: selectminds cursor loaded from storage', read('platform-do.js').includes('selectminds_cursor'));
assert('platform-do: selectminds cursor persisted after fetch', read('platform-do.js').includes('_nextCursor != null'));
assert('platform-do: Browse captures matched jobs too', !read('platform-do.js').includes('passesEnvFilter(job) && !matchJob'));
assert('batch: Browse captures matched jobs too', !read('batch.js').includes('passesEnvFilter(job) && !matchJob'));
assert('index: HC Browse captures matched jobs too', !read('index.js').includes('passesEnvFilter(job) && !matchJob'));
assert('adapters: fetchSelectMinds in dispatcher', adaptersSrc.includes("case 'selectminds':"));
assert('platform-do: fetchSelectMinds imported', read('platform-do.js').includes('fetchSelectMinds'));
assert('platform-do: selectminds case in _fetchJobs', read('platform-do.js').includes("case 'selectminds':"));
assert('platform-do: SelectMindsDO exported', read('platform-do.js').includes('export class SelectMindsDO'));
assert('index: SelectMindsDO exported', read('index.js').includes('SelectMindsDO'));
assert('index: SELECTMINDS_DO in bootstrap', read('index.js').includes("'SELECTMINDS_DO'"));
assert('config: selectminds polling interval defined', read('config.js').includes("selectminds:"));
assert('config: CHUNK_SIZES exported', read('config.js').includes('export const CHUNK_SIZES'));
assert('config: Workday chunkSize is 25', read('config.js').includes('workday:        25,'));
assert('platform-do: CHUNK_SIZE read from CHUNK_SIZES config', read('platform-do.js').includes('CHUNK_SIZES[this.ats] ?? 15'));
assert('enrich: selectminds in NEEDS_PLAIN_FETCH', read('enrich.js').includes("'selectminds'"));
assert('index: bootstrapDOs merges SEED_COMPANIES into stored list', read('index.js').includes('newFromSeed'));
assert('index: PLATFORM_MAP includes selectminds', read('index.js').includes("selectminds: 'SELECTMINDS_DO'"));
assert('index: loadSeenIds returns Map', read('index.js').includes('return new Map()'));
assert('index: addToSeen defined', read('index.js').includes('function addToSeen('));
assert('index: checkSeenStatus defined', read('index.js').includes('function checkSeenStatus('));
assert('index: maybeRunSeenSweep defined', read('index.js').includes('async function maybeRunSeenSweep('));
assert('index: maybeRunSeenSweep called in cron', read('index.js').includes('maybeRunSeenSweep(env)'));
assert('index: cron salary + sweep parallelized', read('index.js').includes('Promise.all([\n    maybeRefreshSalaryCaches(env),\n    maybeRunSeenSweep(env),\n  ])'));
assert('index: UI_ETAG computed at module load', read('index.js').includes('const UI_ETAG = (() =>'));
assert('index: /ui returns 304 on ETag match', read('index.js').includes('status: 304'));
assert('index: /ui ETag header set on 200', read('index.js').includes("'ETag': UI_ETAG"));
assert('index: /ui no-store removed', !read('index.js').includes('no-store'));
assert('index: SEEN_TTL_MS defined', read('index.js').includes('SEEN_TTL_MS'));
assert('index: dead entries marked with diedAt', read('index.js').includes('diedAt'));
assert('index: ghost resurrection in HC path', read('index.js').includes('Ghost resurrected'));
assert('platform-do: ghost resurrection in alarm loop', read('platform-do.js').includes('Ghost resurrected'));
assert('platform-do: globalSeen uses Map format', read('platform-do.js').includes('globalSeen = new Map()'));

// ── R2 salary + description architecture ──────────────────────────────────
assert('wrangler: R2 bucket bound as STAT_R2', read('../wrangler.toml').includes('binding = "STAT_R2"'));
assert('salary: R2 helper _r2Get defined', read('salary.js').includes('async _r2Get(key)'));
assert('salary: R2 helper _r2Put defined', read('salary.js').includes('async _r2Put(key'));
assert('salary: _queryLCAExact uses R2 L1 cache', read('salary.js').includes('this._r2Cache.lca_employer'));
assert('salary: _queryBLS uses R2 L1 cache', read('salary.js').includes('this._r2Cache.bls'));
assert('salary: _refreshLCA writes to R2', read('salary.js').includes("_r2Put('lca-by-employer.json'"));
assert('salary: _refreshBLS uses BLS Public Data API', read('salary.js').includes('api.bls.gov/publicAPI/v2/timeseries'));
assert('salary: _refreshBLS uses correct OEUN series prefix', read('salary.js').includes('OEUN0000000000000'));
assert('salary: LCA uses full 4-digit year URLs', read('salary.js').includes('FY2025_Q4.xlsx'));
assert('enrich: R2 description cache helper defined', read('enrich.js').includes('cacheDescriptionInR2'));
assert('enrich: plain fetch writes to R2', read('enrich.js').includes('cacheDescriptionInR2(env, job.id, desc)'));
assert('index: /description/:jobId endpoint present', read('index.js').includes("startsWith('/description/')"));
assert('index: description served from R2', read('index.js').includes("STAT_R2.get(`desc/${jobId}`)"));
assert('platform-do: matches strip description before store', read('platform-do.js').includes('description: undefined'));
assert('store: RECENT_MATCHES_MAX = 4000', read('store.js').includes('RECENT_MATCHES_MAX = 4000'));
// ── LCA CI refresh workflow ───────────────────────────────────────────────────
assert('lca-parse: script exists', (() => { try { require('fs').readFileSync('scripts/lca-parse.js'); return true; } catch { return false; } })());
assert('lca-parse: RELEVANT_SOC defined', read('../scripts/lca-parse.js').includes("'15-1211'"));
assert('lca-parse: FY2025_Q4 URL candidate present', read('../scripts/lca-parse.js').includes('FY2025_Q4.xlsx'));
assert('lca-parse: indexRows matches _indexLCARows output', read('../scripts/lca-parse.js').includes('Math.floor(mins.length * 0.25)'));
assert('lca-refresh: workflow exists', (() => { try { require('fs').readFileSync('.github/workflows/lca-refresh.yml'); return true; } catch { return false; } })());
assert('lca-refresh: uploads lca-by-employer.json to R2', read('../.github/workflows/lca-refresh.yml').includes('lca-by-employer.json'));

// ─── Results ─────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok);

console.log(`\nSTAT smoke: ${passed}/${results.length} passed\n`);

if (failed.length > 0) {
  console.error('FAILED:');
  failed.forEach(r => console.error(`  ✗ ${r.name}`));
  console.error('');
  process.exit(1);
} else {
  results.forEach(r => console.log(`  ✓ ${r.name}`));
  console.log('\nAll assertions passed.\n');
  process.exit(0);
}
// ── R2 salary + description architecture ──────────────────────────────────
assert('wrangler: R2 bucket bound as STAT_R2', read('../wrangler.toml').includes('binding = "STAT_R2"'));
assert('salary: R2 helper _r2Get defined', read('salary.js').includes('async _r2Get(key)'));
assert('salary: R2 helper _r2Put defined', read('salary.js').includes('async _r2Put(key'));
assert('salary: _queryLCAExact uses R2 L1 cache', read('salary.js').includes('this._r2Cache.lca_employer'));
assert('salary: _queryBLS uses R2 L1 cache', read('salary.js').includes('this._r2Cache.bls'));
assert('salary: _refreshLCA writes to R2', read('salary.js').includes("_r2Put('lca-by-employer.json'"));
assert('salary: _refreshBLS writes to R2', read('salary.js').includes("_r2Put('bls-wages.json'"));
assert('enrich: R2 description cache helper defined', read('enrich.js').includes('cacheDescriptionInR2'));
assert('enrich: plain fetch writes to R2', read('enrich.js').includes('cacheDescriptionInR2(env, job.id, desc)'));
assert('index: /description/:jobId endpoint present', read('index.js').includes("startsWith('/description/')"));
assert('index: description served from R2', read('index.js').includes("STAT_R2.get(`desc/${jobId}`)"));
assert('platform-do: matches strip description before store', read('platform-do.js').includes('description: undefined'));
assert('store: RECENT_MATCHES_MAX = 4000', read('store.js').includes('RECENT_MATCHES_MAX = 4000'));

