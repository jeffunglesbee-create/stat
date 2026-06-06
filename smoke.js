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
