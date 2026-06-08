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
const dedupPos         = pdo.indexOf('seenIds.has(job.id) || globalSeen.has(job.id)');
assert('platform-do: Browse capture before dedup gate',
  unmatchedPushPos !== -1 && dedupPos !== -1 && unmatchedPushPos < dedupPos);

assert('platform-do: saveUnmatchedJobs called in alarm loop',
  pdo.includes('await saveUnmatchedJobs('));

assert('platform-do: saveUnmatchedJobs imported from store',
  pdo.includes('saveUnmatchedJobs') && pdo.includes("from './store.js'"));

// ─── batch.js ────────────────────────────────────────────────────────────────
const batch = read('batch.js');

const batchUnmatchedPos = batch.indexOf('unmatchedJobs.push(job)');
const batchDedupPos     = batch.indexOf('seenIds.has(job.id)');
assert('batch: Browse capture before dedup gate',
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
assert('store: UNMATCHED_MAX >= 2000',
  store.includes('UNMATCHED_MAX = 2000'));
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
assert('index: csvRows quote-aware generator defined', read('index.js').includes('function* csvRows'));
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

// ─── Workday Browser Rendering wiring ────────────────────────────────────────
// Verifies fetchWorkday accepts env param and uses MYBROWSER for XHR intercept.
// Verifies both call sites (platform-do._fetchJobs + adapters.fetchCompanyJobs)
// pass env through — missing env silently falls back to SSR, never catches.
const platformSrc = read('platform-do.js');
assert('adapters: fetchWorkday signature accepts env param',
  adaptersSrc.includes('async function fetchWorkday(company, env)'));
assert('adapters: fetchWorkday checks env.MYBROWSER',
  adaptersSrc.includes('env?.MYBROWSER') && adaptersSrc.includes('wday/cxs'));
assert('adapters: fetchWorkday XHR intercept uses page.on response',
  adaptersSrc.includes("page.on('response'") && adaptersSrc.includes('wday/cxs'));
assert('adapters: fetchWorkday injects searchText epic into request',
  adaptersSrc.includes("searchText = 'epic'") && adaptersSrc.includes("body.limit = 20"));
assert('adapters: fetchWorkday uses DataImpulse proxy when creds present',
  adaptersSrc.includes('--proxy-server=gw.dataimpulse.com:823') && adaptersSrc.includes('page.authenticate'));
assert('adapters: fetchCompanyJobs passes env to fetchWorkday',
  adaptersSrc.includes('return fetchWorkday(company, env)'));
assert('platform-do: _fetchJobs passes this.env to fetchWorkday',
  platformSrc.includes('return fetchWorkday(company, this.env)'));

// ─── /logs endpoint wiring ───────────────────────────────────────────────────
assert('adapters: mapHiringCafeHit exported', read('adapters.js').includes('export function mapHiringCafeHit'));
assert('index: mapHiringCafeHit imported', read('index.js').includes('mapHiringCafeHit'));
assert('index: HC-BR TODO resolved — maps hits with mapHiringCafeHit', read('index.js').includes('jobs = brHits.map(mapHiringCafeHit)'));
assert('store: appendLog exported', read('store.js').includes('export async function appendLog'));
assert('store: readLog exported', read('store.js').includes('export async function readLog'));
assert('index: readLog imported', read('index.js').includes('readLog'));
assert('index: /logs endpoint present', read('index.js').includes("pathname === '/logs'"));
assert('index: /detect-ats endpoint present', read('index.js').includes("pathname === '/detect-ats'"));
assert('store: maybeAddOrPromoteCompany exported', read('store.js').includes('export async function maybeAddOrPromoteCompany'));
assert('store: healthcare gate in maybeAddOrPromoteCompany', read('store.js').includes('_looksLikeEpicEmployer'));
assert('platform-do: maybeAddOrPromoteCompany imported from store', read('platform-do.js').includes('maybeAddOrPromoteCompany'));
assert('platform-do: maybeAddOrPromoteCompany called after match', read('platform-do.js').includes("maybeAddOrPromoteCompany(env, job"));
assert('batch: maybeAddOrPromoteCompany called after match', read('batch.js').includes("maybeAddOrPromoteCompany(this.env, job"));
assert('index: detectAts function defined', read('index.js').includes('function detectAts(rawUrl)'));
assert('ui: detect-ats URL field present', read('ui.html').includes('f-url-detect'));
assert('ui: btn-detect handler wired', read('ui.html').includes("'/detect-ats'"));
assert('platform-do: appendLog imported', read('platform-do.js').includes('appendLog'));
assert('platform-do: appendLog called in alarm loop', read('platform-do.js').includes('await appendLog('));
assert('platform-do: brLog declared in alarm loop', read('platform-do.js').includes('const brLog'));
assert('platform-do: brLog captures workday _source', read('platform-do.js').includes('jobs._source'));
assert('adapters: fetchWorkday tags intercept result', read('adapters.js').includes("brJobs._source = 'intercept'"));
assert('adapters: fetchWorkday tags ssr_next result', read('adapters.js').includes("r._source = 'ssr_next'"));

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
