#!/usr/bin/env node
// scripts/probe-workday-urls.js
//
// Probes every Workday URL extracted from src/config.js.
//
// Two modes:
//   default       — direct GET with a realistic browser UA. Works only from
//                   IPs that Workday hasn't anti-bot-blocked (Cloudflare
//                   Worker IPs do, datacenter IPs typically don't).
//   --via-worker  — proxies the GET through the deployed Worker's
//                   /plain-fetch-test endpoint so the actual fetch runs from
//                   the Cloudflare Worker IP. This is what fetchWorkday uses
//                   in production, so this is the ground-truth signal.
//
// Output: outbox/workday-audit-results.json
//
// Per entry:
//   { name, url, status, httpCode, note, effectiveUrl, isWorkdayResponse,
//     contentLength, mode }
// status: 'active' | 'redirect' | 'dead' | 'error'

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
           'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT = 15;
const PACE_MS = 600;
const VIA_WORKER = process.argv.includes('--via-worker');
const WORKER_BASE = 'https://stat-job-watcher.jeffunglesbee.workers.dev';

function extractList() {
  const out = execSync('node scripts/extract-workday-urls.js', { encoding: 'utf8' });
  return JSON.parse(out);
}

// Direct probe: full GET with Workday-friendly headers
function probeDirect(url) {
  const tmp = '/tmp/wd-probe-body.txt';
  const wFmt = '%{http_code}|%{url_effective}|%{num_redirects}|%{size_download}';
  const r = spawnSync('curl', [
    '-sL', '-A', UA,
    '-H', 'Accept: text/html,*/*',
    '-H', 'Accept-Language: en-US,en;q=0.9',
    '--max-time', String(TIMEOUT), '--max-redirs', '5',
    '-o', tmp, '-w', wFmt, url,
  ], { encoding: 'utf8' });
  if (r.status !== 0) return { error: `curl exit ${r.status}: ${r.stderr?.trim().slice(0, 120)}` };
  const [codeStr, eff, redStr, sizeStr] = r.stdout.trim().split('|');
  const httpCode = parseInt(codeStr, 10) || 0;
  const redirected = (parseInt(redStr, 10) || 0) > 0;
  const contentLength = parseInt(sizeStr, 10) || 0;
  let body = '';
  try { body = fs.readFileSync(tmp, 'utf8').slice(0, 4000); } catch {}
  return { httpCode, effectiveUrl: eff, redirected, contentLength, body };
}

// Proxied probe via Worker /plain-fetch-test
function probeViaWorker(url) {
  const proxyUrl = `${WORKER_BASE}/plain-fetch-test?url=${encodeURIComponent(url)}`;
  const r = spawnSync('curl', [
    '-sL', '--max-time', String(TIMEOUT + 5),
    proxyUrl,
  ], { encoding: 'utf8' });
  if (r.status !== 0) return { error: `curl exit ${r.status}: ${r.stderr?.trim().slice(0, 120)}` };
  let data;
  try { data = JSON.parse(r.stdout); }
  catch { return { error: `non-JSON response from Worker (first 120 chars): ${r.stdout.slice(0, 120)}` }; }
  // /plain-fetch-test response shape (src/routes/diagnostics.js):
  //   { ok, url, http_status, elapsed_ms, body_bytes, is_blocked,
  //     title, og_description, job_ids, job_hrefs, body_text_excerpt }
  // Worker follows redirects internally and does NOT surface finalUrl,
  // so we treat the requested URL as both original and effective. Dead/
  // active classification still works from http_status + body shape.
  if (data.error) return { error: `worker error: ${data.error}` };
  return {
    httpCode: data.http_status || 0,
    effectiveUrl: data.url || url,
    redirected: false,
    contentLength: data.body_bytes || 0,
    body: [data.title || '', data.og_description || '', data.body_text_excerpt || ''].join(' '),
    isBlocked: !!data.is_blocked,
  };
}

function classify(orig, p) {
  if (p.error) return { status: 'error', note: p.error, isWorkdayResponse: false };
  const isWdHost = /workdayjobs\.com/.test(p.effectiveUrl || '');
  const bodyHasWorkday = /workday|wd[1-9]\.|cxs|JobPosting|jobReq|jobs?Found|Job Listing/i.test(p.body || '');
  const isWorkdayResponse = isWdHost && bodyHasWorkday;

  if (p.isBlocked) return { status: 'error', note: `HTTP ${p.httpCode} bot-blocked`, isWorkdayResponse };

  if (p.httpCode === 200) {
    if (!isWdHost) return { status: 'redirect', note: `migrated off Workday → ${p.effectiveUrl}`, isWorkdayResponse };
    if (p.redirected && p.effectiveUrl !== orig) return { status: 'redirect', note: `→ ${p.effectiveUrl}`, isWorkdayResponse };
    if (isWorkdayResponse) return { status: 'active', note: '', isWorkdayResponse };
    return { status: 'active', note: 'HTTP 200 but body did not look like a Workday SSR page', isWorkdayResponse };
  }
  if (p.httpCode === 404) return { status: 'dead', note: 'HTTP 404', isWorkdayResponse };
  if (p.httpCode === 410) return { status: 'dead', note: 'HTTP 410 (gone)', isWorkdayResponse };
  if (p.httpCode === 403) return { status: 'error', note: 'HTTP 403 — possibly bot block', isWorkdayResponse };
  if (p.httpCode >= 400 && p.httpCode < 500) return { status: 'dead', note: `HTTP ${p.httpCode}`, isWorkdayResponse };
  if (p.httpCode === 0) return { status: 'error', note: 'no response', isWorkdayResponse };
  return { status: 'error', note: `HTTP ${p.httpCode}`, isWorkdayResponse };
}

async function main() {
  const list = extractList();
  const mode = VIA_WORKER ? 'via-worker' : 'direct';
  console.error(`probing ${list.length} Workday URLs (mode=${mode})...`);
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const { name, url } = list[i];
    const p = VIA_WORKER ? probeViaWorker(url) : probeDirect(url);
    const c = classify(url, p);
    results.push({
      name, url, mode,
      status: c.status,
      httpCode: p.httpCode || 0,
      note: c.note,
      effectiveUrl: p.effectiveUrl || '',
      redirected: !!p.redirected,
      isWorkdayResponse: !!c.isWorkdayResponse,
      contentLength: p.contentLength || 0,
    });
    process.stderr.write(`  ${i + 1}/${list.length} ${c.status.padEnd(8)} ${p.httpCode || 'ERR'} ${name}\n`);
    await new Promise(r => setTimeout(r, PACE_MS));
  }
  fs.mkdirSync('outbox', { recursive: true });
  fs.writeFileSync('outbox/workday-audit-results.json', JSON.stringify(results, null, 2));

  const tally = results.reduce((acc, r) => (acc[r.status] = (acc[r.status] || 0) + 1, acc), {});
  console.error(`\nSummary (mode=${mode}): ${JSON.stringify(tally)}`);
  console.error(`Wrote outbox/workday-audit-results.json (${results.length} entries)`);
}

main().catch(e => { console.error(e); process.exit(1); });
