#!/usr/bin/env node
/**
 * STAT — LCA Salary Cache Builder
 *
 * Downloads DOL OFLC H-1B LCA disclosure XLSX from dol.gov (accessible from
 * GitHub Actions runners; blocked from Cloudflare Worker IPs via Akamai WAF).
 * Parses with xlsx npm package. Writes byEmployer + bySoc JSON to R2 via
 * wrangler r2 object put.
 *
 * Run from: .github/workflows/lca-refresh.yml (quarterly + workflow_dispatch)
 * Output:   stat-salary-cache/lca-by-employer.json
 *           stat-salary-cache/lca-by-soc.json
 *
 * Matches output format of SalaryInferenceDO._indexLCARows() exactly.
 * Worker reads these files via _r2Get() in _queryLCAExact() and _queryLCABySOC().
 */

const { readFileSync, writeFileSync, unlinkSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { execSync } = require('child_process');
const { createReadStream } = require('fs');
const readline = require('readline');

// ── Config ────────────────────────────────────────────────────────────────────

const RELEVANT_SOC = ['15-1211', '15-1299', '11-9111', '13-1111'];

// DOL XLSX candidates — full 4-digit fiscal year in filenames.
// FY2025_Q4 confirmed live and accessible (HTTP 200 from CI runner).
// FY2026_Q1/Q2 added optimistically — will 404 until DOL releases them.
const CANDIDATES = [
  'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2026_Q2.xlsx',
  'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2026_Q1.xlsx',
  'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2025_Q4.xlsx',
  'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2025_Q3.xlsx',
];

// ── Download ──────────────────────────────────────────────────────────────────

async function downloadFile(url, destPath) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 STAT/1.0 (LCA salary cache builder)',
      'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  writeFileSync(destPath, Buffer.from(buf));
  console.log(`  Downloaded ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB`);
}

// ── Parse ─────────────────────────────────────────────────────────────────────

async function parseXLSX(filePath) {
  console.log('  Converting XLSX to CSV via xlsx2csv (streaming)...');
  const csvPath = filePath.replace('.xlsx', '.csv');
  
  try {
    // xlsx2csv processes the file in Python's streaming mode — handles 70MB+ files
    // without loading everything into memory simultaneously
    execSync(`xlsx2csv "${filePath}" "${csvPath}"`, { stdio: 'pipe', timeout: 120000 });
    console.log('  Conversion complete');
  } catch (e) {
    console.log('  xlsx2csv failed:', e.message?.slice(0, 200));
    return [];
  }

  console.log('  Parsing CSV...');
  const rows = [];
  let headers = null;
  let lineCount = 0;

  await new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: createReadStream(csvPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      lineCount++;
      const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').replace(/""/g, '"'));
      if (!headers) {
        headers = cols.map(h => h.toUpperCase().trim());
        console.log('  Columns (first 15):', headers.slice(0, 15).join(' | '));
        return;
      }
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (cols[i] || '').trim(); });
      rows.push(obj);
      if (rows.length > 500000) rl.close();
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });

  console.log(`  Parsed ${rows.length.toLocaleString()} raw rows from ${lineCount.toLocaleString()} lines`);
  
  // Clean up CSV file
  try { require('fs').unlinkSync(csvPath); } catch {}
  return rows;
}



// ── Filter + normalize ────────────────────────────────────────────────────────

function filterRows(rows) {
  const result = [];
  for (const row of rows) {
    // Status gate — only certified applications
    const status = String(row['CASE_STATUS'] || '').trim().toUpperCase();
    if (status !== 'CERTIFIED' && status !== 'CERTIFIED-WITHDRAWN') continue;

    // SOC filter — only relevant healthcare IT codes
    const soc = String(row['SOC_CODE'] || '').trim().replace(/['"]/g, '');
    if (!RELEVANT_SOC.some(s => soc.startsWith(s.slice(0, 5)))) continue;

    // Wage extraction
    const wageMinStr = String(row['WAGE_RATE_OF_PAY_FROM'] || row['PREVAILING_WAGE'] || '');
    const wageMaxStr = String(row['WAGE_RATE_OF_PAY_TO']   || '');
    const unit       = String(row['WAGE_UNIT_OF_PAY']       || '').toLowerCase();
    const employer   = String(row['EMPLOYER_NAME']           || '').trim();
    const state      = String(row['WORKSITE_STATE'] || row['EMPLOYER_STATE'] || '').trim();

    const wageMin = parseFloat(wageMinStr.replace(/[$,]/g, ''));
    const wageMax = parseFloat(wageMaxStr.replace(/[$,]/g, ''));
    if (!wageMin || isNaN(wageMin)) continue;

    // Normalize to annual
    let annualMin, annualMax;
    if (unit.includes('hour')) {
      annualMin = wageMin * 2080;
      annualMax = (wageMax || wageMin) * 2080;
    } else if (unit.includes('week')) {
      annualMin = wageMin * 52;
      annualMax = (wageMax || wageMin) * 52;
    } else if (unit.includes('month')) {
      annualMin = wageMin * 12;
      annualMax = (wageMax || wageMin) * 12;
    } else if (unit.includes('bi-weekly') || unit.includes('biweekly')) {
      annualMin = wageMin * 26;
      annualMax = (wageMax || wageMin) * 26;
    } else {
      // Default: assume annual
      annualMin = wageMin;
      annualMax = wageMax || wageMin;
    }

    if (annualMin < 20000 || annualMin > 600000) continue;

    result.push({ soc, employer, state, min: annualMin, max: annualMax });
  }
  console.log(`  Filtered to ${result.length.toLocaleString()} relevant rows`);
  return result;
}

// ── Index (mirrors SalaryInferenceDO._indexLCARows exactly) ──────────────────

function indexRows(rows, period) {
  const empAccum = {};
  const socAccum = {};

  for (const row of rows) {
    if (!row.soc || !row.min) continue;

    const empKey = (row.employer || '').toLowerCase().trim();
    if (empKey && empKey.length > 2) {
      if (!empAccum[empKey]) empAccum[empKey] = [];
      empAccum[empKey].push({ min: row.min, max: row.max });
    }

    const socBase  = row.soc.slice(0, 7);
    const stateKey = `${socBase}:${row.state}`;
    const natKey   = `${socBase}:national`;

    if (row.state) {
      if (!socAccum[stateKey]) socAccum[stateKey] = [];
      socAccum[stateKey].push(row.min);
    }
    if (!socAccum[natKey]) socAccum[natKey] = [];
    socAccum[natKey].push(row.min);
  }

  // Employer summaries (≥3 data points)
  const byEmployer = {};
  for (const [emp, entries] of Object.entries(empAccum)) {
    if (entries.length < 3) continue;
    const mins = entries.map(e => e.min).sort((a, b) => a - b);
    const maxs = entries.map(e => e.max).sort((a, b) => a - b);
    const origRow = rows.find(r => (r.employer || '').toLowerCase().trim() === emp);
    const origName = origRow?.employer || emp;
    const state    = origRow?.state    || null;

    byEmployer[origName] = {
      min:      mins[Math.floor(mins.length * 0.25)],
      max:      maxs[Math.floor(maxs.length * 0.75)],
      count:    entries.length,
      state,
      employer: origName,
      period,
    };
  }

  // SOC summaries (≥5 data points)
  const bySoc = {};
  for (const [key, vals] of Object.entries(socAccum)) {
    if (vals.length < 5) continue;
    vals.sort((a, b) => a - b);
    const n = vals.length;
    bySoc[key] = {
      p25:    vals[Math.floor(n * 0.25)],
      p50:    vals[Math.floor(n * 0.50)],
      p75:    vals[Math.floor(n * 0.75)],
      count:  n,
      state:  key.split(':')[1],
      period,
    };
  }

  return { byEmployer, bySoc };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {

  const tmpFile = join(tmpdir(), `lca-${Date.now()}.xlsx`);

  let successUrl = null;
  let period = null;

  for (const url of CANDIDATES) {
    console.log(`\nTrying: ${url}`);
    try {
      await downloadFile(url, tmpFile);
      successUrl = url;
      period = url.match(/FY(\d{4})_Q(\d)/)?.[0] || 'recent';
      console.log(`  Period: ${period}`);
      break;
    } catch (e) {
      console.log(`  Failed: ${e.message}`);
    }
  }

  if (!successUrl) {
    console.error('ERROR: No LCA file reachable from any candidate URL');
    process.exit(1);
  }

  const rawRows  = await parseXLSX(tmpFile);
  const filtered = filterRows(rawRows);
  const { byEmployer, bySoc } = indexRows(filtered, period);

  console.log(`\nIndex results:`);
  console.log(`  Employers: ${Object.keys(byEmployer).length.toLocaleString()}`);
  console.log(`  SOC keys:  ${Object.keys(bySoc).length}`);

  // Write result files for wrangler to upload
  writeFileSync('/tmp/lca-by-employer.json', JSON.stringify(byEmployer));
  writeFileSync('/tmp/lca-by-soc.json',      JSON.stringify(bySoc));
  // Clean up temp XLSX
  try { unlinkSync(tmpFile); } catch {}

  // Always write meta + debug before any exit — CI reads this via outbox commit
  const meta = {
    period, url: successUrl,
    employers: Object.keys(byEmployer).length,
    socKeys: Object.keys(bySoc).length,
    rows: filtered.length,
    builtAt: new Date().toISOString(),
  };
  writeFileSync('/tmp/lca-meta.json', JSON.stringify(meta, null, 2));

  if (filtered.length === 0) {
    console.error('\nERROR: 0 rows after filtering — check debug.Columns above for actual column names');
    process.exit(1);
  }

  console.log('\nFiles written to /tmp — ready for R2 upload');
}

main().catch(e => { console.error(e); process.exit(1); });
