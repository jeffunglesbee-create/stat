#!/usr/bin/env node
// scripts/probe-workday-urls.js
//
// Probes every Workday URL extracted from src/config.js with a real-browser
// User-Agent and full GET (HEAD often blocked). Writes a results JSON to
// outbox/workday-audit-results.json with one entry per URL.
//
// Designed for GitHub Actions runners — local sandbox egress allowlists
// typically block *.myworkdayjobs.com.
//
// Output schema (per entry):
//   { name, url, status, httpCode, note, effectiveUrl, redirected,
//     isWorkdayResponse, contentLength }
// status: 'active' | 'redirect' | 'dead' | 'error'

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
           'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const TIMEOUT = 12;
const PACE_MS = 600;

function extractList() {
  const out = execSync('node scripts/extract-workday-urls.js', { encoding: 'utf8' });
  return JSON.parse(out);
}

function probe(url) {
  const tmp = '/tmp/wd-probe-body.txt';
  const wFmt = '%{http_code}|%{url_effective}|%{num_redirects}|%{size_download}';
  const r = spawnSync('curl', [
    '-sL', '-A', UA,
    '--max-time', String(TIMEOUT), '--max-redirs', '5',
    '-o', tmp, '-w', wFmt, url,
  ], { encoding: 'utf8' });
  if (r.status !== 0) {
    return { error: `curl exit ${r.status}: ${r.stderr?.trim().slice(0, 120)}` };
  }
  const [codeStr, eff, redStr, sizeStr] = r.stdout.trim().split('|');
  const httpCode = parseInt(codeStr, 10) || 0;
  const redirected = (parseInt(redStr, 10) || 0) > 0;
  const contentLength = parseInt(sizeStr, 10) || 0;
  let body = '';
  try { body = fs.readFileSync(tmp, 'utf8').slice(0, 4000); } catch {}
  return { httpCode, effectiveUrl: eff, redirected, contentLength, body };
}

function classify(orig, p) {
  if (p.error) return { status: 'error', note: p.error, isWorkdayResponse: false };
  const isWdHost = /workdayjobs\.com/.test(p.effectiveUrl || '');
  const bodyHasWorkday = /workday|wd[1-9]\.|cxs|JobPosting/i.test(p.body || '');
  const isWorkdayResponse = isWdHost && bodyHasWorkday;

  if (p.httpCode === 200) {
    if (!isWdHost) return { status: 'redirect', note: `migrated off Workday → ${p.effectiveUrl}`, isWorkdayResponse };
    if (p.redirected && p.effectiveUrl !== orig) return { status: 'redirect', note: `→ ${p.effectiveUrl}`, isWorkdayResponse };
    if (isWorkdayResponse) return { status: 'active', note: '', isWorkdayResponse };
    return { status: 'active', note: 'HTTP 200 but body did not look like a Workday SSR page', isWorkdayResponse };
  }
  if (p.httpCode === 404) return { status: 'dead', note: 'HTTP 404', isWorkdayResponse };
  if (p.httpCode === 410) return { status: 'dead', note: 'HTTP 410 (gone)', isWorkdayResponse };
  if (p.httpCode === 403 && /Access Denied|deny|forbidden/i.test(p.body || '')) {
    return { status: 'error', note: 'HTTP 403 — possibly bot block, not necessarily dead', isWorkdayResponse };
  }
  if (p.httpCode === 403) return { status: 'error', note: 'HTTP 403', isWorkdayResponse };
  if (p.httpCode >= 400 && p.httpCode < 500) return { status: 'dead', note: `HTTP ${p.httpCode}`, isWorkdayResponse };
  if (p.httpCode === 0) return { status: 'error', note: 'no response', isWorkdayResponse };
  return { status: 'error', note: `HTTP ${p.httpCode}`, isWorkdayResponse };
}

async function main() {
  const list = extractList();
  console.error(`probing ${list.length} Workday URLs...`);
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const { name, url } = list[i];
    const p = probe(url);
    const c = classify(url, p);
    results.push({
      name, url,
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
  console.error(`\nSummary: ${JSON.stringify(tally)}`);
  console.error(`Wrote outbox/workday-audit-results.json (${results.length} entries)`);
}

main().catch(e => { console.error(e); process.exit(1); });
