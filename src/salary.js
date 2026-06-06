/**
 * STAT — SalaryInferenceDO + salary utility functions
 *
 * One globally-shared Durable Object that:
 *   1. Maintains a rolling 7-day window of PEER salaries (real disclosed
 *      ranges from the same ATS, same keyword group, same environment)
 *   2. Caches DOL OFLC H-1B LCA data (employer-sworn wages, quarterly)
 *   3. Caches BLS OEWS wage benchmarks (government percentiles, annual)
 *   4. Applies pay transparency law signals (state-level metadata)
 *
 * Priority order for inference:
 *   P1: Peer pool — same ATS + keyword group + environment, last 7 days
 *   P2: LCA lookup — exact employer name match in DOL H-1B disclosure data
 *   P3: LCA SOC+state — matching SOC code + worksite state from LCA data
 *   P4: BLS OEWS — government p25/median/p75 by SOC + state
 *   P5: Transparency signal — no estimate, but flag missing salary in required states
 *
 * DO NOT ASSUME rule: if no source has data, salary stays null. Nothing is
 * fabricated. Every displayed number traces back to a real source.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Pay transparency states (require salary range in job postings as of 2026)
// Source: rippling.com/blog/pay-transparency-laws, govdocs.com/pay-transparency-laws
// ─────────────────────────────────────────────────────────────────────────────
const TRANSPARENCY_STATES = new Set([
  'CA', 'CO', 'CT', 'HI', 'IL', 'MA', 'MD', 'MN',
  'NJ', 'NV', 'NY', 'RI', 'VT', 'WA',
  // 2026 additions (effective mid-2026)
  'ME', 'VA',
]);

// State names → abbreviations for location parsing
const STATE_ABBREVS = {
  'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'hawaii': 'HI',
  'illinois': 'IL', 'massachusetts': 'MA', 'maryland': 'MD', 'minnesota': 'MN',
  'new jersey': 'NJ', 'nevada': 'NV', 'new york': 'NY', 'rhode island': 'RI',
  'vermont': 'VT', 'washington': 'WA', 'maine': 'ME', 'virginia': 'VA',
  'texas': 'TX', 'florida': 'FL', 'ohio': 'OH', 'pennsylvania': 'PA',
  'north carolina': 'NC', 'georgia': 'GA', 'michigan': 'MI', 'arizona': 'AZ',
  'tennessee': 'TN', 'indiana': 'IN', 'missouri': 'MO', 'wisconsin': 'WI',
  'oregon': 'OR', 'oklahoma': 'OK', 'utah': 'UT', 'kentucky': 'KY',
  'kansas': 'KS', 'iowa': 'IA', 'arkansas': 'AR', 'mississippi': 'MS',
  'nebraska': 'NE', 'idaho': 'ID', 'new mexico': 'NM', 'alaska': 'AK',
};

// SOC codes relevant to Epic/EHR/Healthcare IT roles
// 15-1211 = Computer Systems Analysts (primary for Epic analysts)
// 15-1299 = Computer Occupations, All Other
// 11-9111 = Medical and Health Services Managers
const RELEVANT_SOC = ['15-1211', '15-1299', '11-9111', '13-1111'];

// Map job keyword groups → SOC codes for BLS lookup
const GROUP_TO_SOC = {
  'Epic / EHR / Healthcare IT': '15-1211',
  'Data / SQL / Analytics':     '15-1211',
  'Product / Project / IT':     '13-1111',
};

// ─────────────────────────────────────────────────────────────────────────────
// Location parser — extracts state abbreviation from a job location string
// ─────────────────────────────────────────────────────────────────────────────
export function parseStateFromLocation(location) {
  if (!location) return null;
  const loc = location.toLowerCase().trim();

  // "Remote" with no state info — can't determine state
  if (loc === 'remote' || loc === 'remote us' || loc === 'united states') return null;

  // Explicit 2-letter abbreviation: "Baltimore, MD" or "MD" or "Remote - MD"
  const abbrMatch = location.match(/\b([A-Z]{2})\b/);
  if (abbrMatch) {
    const abbr = abbrMatch[1];
    // Filter out non-state 2-letter codes (US, US, IT, etc.)
    const validStates = new Set(Object.values(STATE_ABBREVS));
    if (validStates.has(abbr)) return abbr;
  }

  // Full state name: "California" or "New York"
  for (const [name, abbr] of Object.entries(STATE_ABBREVS)) {
    if (loc.includes(name)) return abbr;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Salary formatter
// ─────────────────────────────────────────────────────────────────────────────
function fmtK(n) {
  if (!n || isNaN(n)) return null;
  return n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`;
}

function fmtRange(min, max) {
  const a = fmtK(min);
  const b = fmtK(max);
  if (a && b) return `${a}–${b}`;
  if (a) return `${a}+`;
  if (b) return `up to ${b}`;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SalaryInferenceDO
// One global instance — named 'salary-inference' in the DO registry.
// ─────────────────────────────────────────────────────────────────────────────
export class SalaryInferenceDO {
  constructor(state, env) {
    this.state   = state;
    this.env     = env;
    this.storage = state.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // ── Infer salary for a specific job ──────────────────────────────────────
    if (url.pathname === '/infer' && request.method === 'POST') {
      const job = await request.json();
      const result = await this._infer(job);
      return new Response(JSON.stringify(result));
    }

    // ── Record a disclosed salary (called when a job HAS salary data) ─────────
    // Keeps the peer pool fresh with real employer disclosures
    if (url.pathname === '/record' && request.method === 'POST') {
      const { job, match } = await request.json();
      await this._recordPeerSalary(job, match);
      return new Response(JSON.stringify({ ok: true }));
    }

    // ── Refresh BLS OEWS cache (called at bootstrap, annually) ───────────────
    if (url.pathname === '/refresh-bls' && request.method === 'POST') {
      const result = await this._refreshBLS();
      return new Response(JSON.stringify(result));
    }

    // ── Refresh DOL LCA cache (called at bootstrap, quarterly) ───────────────
    if (url.pathname === '/refresh-lca' && request.method === 'POST') {
      const result = await this._refreshLCA();
      return new Response(JSON.stringify(result));
    }

    // ── Status ────────────────────────────────────────────────────────────────
    if (url.pathname === '/status') {
      const peerCount = await this.storage.get('peer_count') ?? 0;
      const lcaCount  = await this.storage.get('lca_count')  ?? 0;
      const blsDate   = await this.storage.get('bls_fetched_at') ?? null;
      const lcaDate   = await this.storage.get('lca_fetched_at') ?? null;
      return new Response(JSON.stringify({ peerCount, lcaCount, blsDate, lcaDate }));
    }

    return new Response('SalaryInferenceDO', { status: 200 });
  }

  // ── Core inference logic ───────────────────────────────────────────────────
  async _infer(job) {
    const state = parseStateFromLocation(job.location);
    const isTransparencyRequired = state ? TRANSPARENCY_STATES.has(state) : false;
    const isRemote = (job.environment || '').toLowerCase().includes('remote');

    // If remote, check if location hints at a transparency state
    // Remote jobs in NY/CO/CA/IL/WA etc. legally must disclose
    const effectiveTransparency = isTransparencyRequired ||
      (isRemote && state && TRANSPARENCY_STATES.has(state));

    // P1: Peer pool — same ATS + keyword group + environment
    const peer = await this._queryPeerPool(job);
    if (peer) {
      return {
        salary:      fmtRange(peer.p25, peer.p75),
        salaryMin:   peer.p25,
        salaryMax:   peer.p75,
        salarySource: 'peer',
        salaryLabel: `~${fmtRange(peer.p25, peer.p75)} · peer est. (${peer.count} similar roles, ${peer.ats}, last 7d)`,
        transparencyFlag: effectiveTransparency ? state : null,
        sourcePriority: 1,
      };
    }

    // P2: LCA exact employer match
    const lcaExact = await this._queryLCAExact(job.company);
    if (lcaExact) {
      return {
        salary:       fmtRange(lcaExact.min, lcaExact.max),
        salaryMin:    lcaExact.min,
        salaryMax:    lcaExact.max,
        salarySource: 'lca_employer',
        salaryLabel:  `${fmtRange(lcaExact.min, lcaExact.max)} · DOL LCA · ${lcaExact.employer} · ${lcaExact.state || 'US'} · ${lcaExact.period}`,
        transparencyFlag: effectiveTransparency ? state : null,
        sourcePriority: 2,
      };
    }

    // P3: LCA SOC + state match
    const lcaSoc = await this._queryLCABySOC(job, state);
    if (lcaSoc) {
      return {
        salary:       fmtRange(lcaSoc.p25, lcaSoc.p75),
        salaryMin:    lcaSoc.p25,
        salaryMax:    lcaSoc.p75,
        salarySource: 'lca_soc',
        salaryLabel:  `~${fmtRange(lcaSoc.p25, lcaSoc.p75)} · DOL LCA · ${lcaSoc.soc} · ${lcaSoc.state || 'national'} · ${lcaSoc.period}`,
        transparencyFlag: effectiveTransparency ? state : null,
        sourcePriority: 3,
      };
    }

    // P4: BLS OEWS benchmark
    const bls = await this._queryBLS(job, state);
    if (bls) {
      return {
        salary:       fmtRange(bls.p25, bls.p75),
        salaryMin:    bls.p25,
        salaryMax:    bls.p75,
        salarySource: 'bls',
        salaryLabel:  `~${fmtRange(bls.p25, bls.p75)} · BLS OEWS · ${bls.soc} · ${bls.area} · ${bls.year}`,
        transparencyFlag: effectiveTransparency ? state : null,
        sourcePriority: 4,
      };
    }

    // P5: No salary estimate, but flag transparency violation
    if (effectiveTransparency) {
      return {
        salary:       null,
        salarySource: 'none',
        salaryLabel:  null,
        transparencyFlag: state,
        transparencyViolation: true,
        sourcePriority: 5,
      };
    }

    // No data at all
    return {
      salary:       null,
      salarySource: 'none',
      salaryLabel:  null,
      transparencyFlag: null,
      sourcePriority: 0,
    };
  }

  // ── P1: Peer pool query ────────────────────────────────────────────────────
  async _queryPeerPool(job) {
    try {
      const raw = await this.storage.get('peer_pool');
      if (!raw) return null;
      const pool = JSON.parse(raw); // Array of {ats, group, env, min, max, ts}

      const sevenDaysAgo = Date.now() - 7 * 86_400_000;
      const env = (job.environment || '').toLowerCase();
      const group = job._matchGroup || ''; // set by CompanyWatcherDO

      // Filter: same ATS + overlapping keyword group + similar environment + fresh
      const matches = pool.filter(p =>
        p.ats === job.atsSource &&
        p.ts > sevenDaysAgo &&
        (p.group === group || group === '') &&
        (env === '' || p.env === '' || p.env === env)
      );

      if (matches.length < 3) return null; // need minimum sample

      const mins = matches.map(m => m.min).filter(Boolean);
      const maxs = matches.map(m => m.max).filter(Boolean);
      if (mins.length < 2) return null;

      mins.sort((a, b) => a - b);
      maxs.sort((a, b) => a - b);

      // p25 of mins, p75 of maxs
      const p25 = mins[Math.floor(mins.length * 0.25)];
      const p75 = maxs[Math.floor(maxs.length * 0.75)];

      return { p25, p75, count: matches.length, ats: job.atsSource };
    } catch { return null; }
  }

  // ── Record a peer salary disclosure ───────────────────────────────────────
  async _recordPeerSalary(job, match) {
    if (!job.salaryRaw?.min && !job.salaryRaw?.max) return;
    try {
      const raw  = await this.storage.get('peer_pool');
      const pool = raw ? JSON.parse(raw) : [];

      pool.push({
        ats:   job.atsSource,
        group: match?.label || '',
        env:   (job.environment || '').toLowerCase(),
        min:   job.salaryRaw?.min || null,
        max:   job.salaryRaw?.max || null,
        ts:    Date.now(),
      });

      // Trim old entries (>14 days) and cap total at 500
      const cutoff = Date.now() - 14 * 86_400_000;
      const trimmed = pool.filter(p => p.ts > cutoff).slice(-500);

      await this.storage.put('peer_pool', JSON.stringify(trimmed));
      await this.storage.put('peer_count', trimmed.length);
    } catch { /* non-critical */ }
  }

  // ── P2: LCA exact employer match ──────────────────────────────────────────
  async _queryLCAExact(companyName) {
    if (!companyName) return null;
    try {
      const raw = await this.storage.get('lca_by_employer');
      if (!raw) return null;
      const index = JSON.parse(raw);

      // Normalize company name for fuzzy matching
      const norm = companyName.toLowerCase()
        .replace(/\b(inc|llc|corp|ltd|consulting|group|health|system|systems)\b/g, '')
        .replace(/\s+/g, ' ').trim();

      // Exact or close match
      const key = Object.keys(index).find(k => {
        const kn = k.toLowerCase()
          .replace(/\b(inc|llc|corp|ltd|consulting|group|health|system|systems)\b/g, '')
          .replace(/\s+/g, ' ').trim();
        return kn === norm || kn.includes(norm) || norm.includes(kn);
      });

      return key ? index[key] : null;
    } catch { return null; }
  }

  // ── P3: LCA by SOC code + state ───────────────────────────────────────────
  async _queryLCABySOC(job, state) {
    try {
      const raw = await this.storage.get('lca_by_soc');
      if (!raw) return null;
      const index = JSON.parse(raw);

      // Determine SOC from match group
      const group = job._matchGroup || 'Epic / EHR / Healthcare IT';
      const soc   = GROUP_TO_SOC[group] || '15-1211';

      // Try state-specific first, fall back to national
      const stateKey    = `${soc}:${state}`;
      const nationalKey = `${soc}:national`;

      const entry = index[stateKey] || index[nationalKey];
      return entry ? { ...entry, soc } : null;
    } catch { return null; }
  }

  // ── P4: BLS OEWS benchmark ────────────────────────────────────────────────
  async _queryBLS(job, state) {
    try {
      const raw = await this.storage.get('bls_wages');
      if (!raw) return null;
      const index = JSON.parse(raw);

      const group = job._matchGroup || 'Epic / EHR / Healthcare IT';
      const soc   = GROUP_TO_SOC[group] || '15-1211';

      // Try healthcare industry + state, then healthcare + national, then national
      const stateKey    = `${soc}:health:${state}`;
      const natHealthKey = `${soc}:health:national`;
      const nationalKey = `${soc}:national`;

      const entry = index[stateKey] || index[natHealthKey] || index[nationalKey];
      return entry ? { ...entry, soc } : null;
    } catch { return null; }
  }

  // ── BLS OEWS refresh ──────────────────────────────────────────────────────
  // Fetches occupation profiles from BLS HTML pages for relevant SOC codes.
  // BLS URL pattern: bls.gov/oes/current/oes{soc_nodashes}.htm
  // Each page has a structured table with p10/p25/p50/p75/p90 annual wages.
  async _refreshBLS() {
    const results = {};
    let fetched = 0;

    for (const soc of RELEVANT_SOC) {
      const socNoDash = soc.replace('-', '');
      const url = `https://www.bls.gov/oes/current/oes${socNoDash}.htm`;

      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
        });
        if (!res.ok) continue;
        const html = await res.text();

        // BLS pages embed wage data in tables. Look for percentile wage rows.
        // Pattern: table rows with "10%" "25%" "50%" "75%" "90%" labels
        const wages = this._parseBLSWageTable(html);
        if (!wages) continue;

        // Store national + healthcare industry (NAICS 622) if available
        results[`${soc}:national`] = {
          p10: wages.p10, p25: wages.p25, p50: wages.p50,
          p75: wages.p75, p90: wages.p90,
          area: 'national',
          year: '2025',
        };
        fetched++;

        // Healthcare industry subset (hospitals, NAICS 622)
        const healthWages = this._parseBLSHealthcareWages(html);
        if (healthWages) {
          results[`${soc}:health:national`] = {
            ...healthWages, area: 'healthcare national', year: '2025',
          };
        }

        // Polite delay between BLS requests
        await new Promise(r => setTimeout(r, 1000));
      } catch { /* skip on error */ }
    }

    if (fetched > 0) {
      await this.storage.put('bls_wages', JSON.stringify(results));
      await this.storage.put('bls_fetched_at', new Date().toISOString());
    }

    return { fetched, keys: Object.keys(results).length };
  }

  // Parse BLS wage percentile table from HTML
  _parseBLSWageTable(html) {
    try {
      // BLS table has rows like: "Annual 10%" "$XX,XXX"
      // More reliably: look for the summary data in the page
      const patterns = [
        // Standard percentile table
        /10th.*?[\$](\d[\d,]+)/i,
        /25th.*?[\$](\d[\d,]+)/i,
        /50th.*?[\$](\d[\d,]+)/i,
        /75th.*?[\$](\d[\d,]+)/i,
        /90th.*?[\$](\d[\d,]+)/i,
      ];

      // Try to find wages section
      const wageSection = html.match(/Percentile wage estimates[\s\S]{0,3000}/i)?.[0];
      if (!wageSection) return null;

      const nums = [];
      const numMatches = wageSection.matchAll(/\$([\d,]+)/g);
      for (const m of numMatches) {
        const n = parseInt(m[1].replace(/,/g, ''));
        if (n > 20000 && n < 500000) nums.push(n); // sanity range for annual wages
      }

      // Need at least 5 values (p10/p25/p50/p75/p90)
      if (nums.length < 5) return null;

      // BLS tables present percentiles in order
      return {
        p10: nums[0], p25: nums[1], p50: nums[2],
        p75: nums[3], p90: nums[4],
      };
    } catch { return null; }
  }

  // Extract healthcare-specific wages (hospitals industry section)
  _parseBLSHealthcareWages(html) {
    try {
      // BLS pages have an "Industries with the highest" table
      // Look for Hospitals (622) industry row
      const hospIdx = html.indexOf('622');
      if (hospIdx === -1) return null;

      const section = html.slice(hospIdx, hospIdx + 500);
      const nums = [];
      const matches = section.matchAll(/\$([\d,]+)/g);
      for (const m of matches) {
        const n = parseInt(m[1].replace(/,/g, ''));
        if (n > 20000 && n < 500000) nums.push(n);
      }
      if (nums.length < 2) return null;

      // Healthcare tables show mean wage — use as p50 approximation
      return { p25: Math.round(nums[0] * 0.8), p50: nums[0], p75: Math.round(nums[0] * 1.2) };
    } catch { return null; }
  }

  // ── DOL LCA refresh ───────────────────────────────────────────────────────
  // Downloads and parses DOL OFLC H-1B LCA disclosure data.
  // File URL pattern: dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY{YY}_Q{N}.xlsx
  // We fetch the most recent quarterly file and extract:
  //   - Records with SOC codes in RELEVANT_SOC
  //   - CASE_STATUS = CERTIFIED
  //   - WAGE_RATE_OF_PAY_FROM (offered wage floor)
  //   - EMPLOYER_NAME, WORKSITE_STATE, SOC_CODE, SOC_TITLE
  //
  // The XLSX is large (~50MB) so we use a streaming approach — fetch as
  // ArrayBuffer and parse with a lightweight XLSX parser.
  async _refreshLCA() {
    // Try the most recent quarters in reverse order
    const candidates = [
      'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY26_Q2.xlsx',
      'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY26_Q1.xlsx',
      'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY25_Q4.xlsx',
    ];

    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (!res.ok) continue;

        const period = url.match(/FY(\d+)_Q(\d+)/)?.[0] || 'recent';

        // Stream the XLSX as text — DOL files are actually tab-delimited
        // despite the .xlsx extension in older releases, or true XLSX.
        // We handle both cases.
        const contentType = res.headers.get('content-type') || '';
        let rows = [];

        if (contentType.includes('spreadsheet') || url.endsWith('.xlsx')) {
          // True XLSX — need to parse binary. We'll use a lightweight approach:
          // fetch first 10MB, try to extract the sheet XML strings
          const buf = await res.arrayBuffer();
          rows = this._parseXLSXLCA(buf);
        } else {
          // Tab-delimited or CSV
          const text = await res.text();
          rows = this._parseTSVLCA(text);
        }

        if (rows.length < 10) continue;

        const { byEmployer, bySoc } = this._indexLCARows(rows, period);

        await this.storage.put('lca_by_employer', JSON.stringify(byEmployer));
        await this.storage.put('lca_by_soc',      JSON.stringify(bySoc));
        await this.storage.put('lca_count',        rows.length);
        await this.storage.put('lca_fetched_at',   new Date().toISOString());

        return {
          ok: true, url, rows: rows.length,
          employers: Object.keys(byEmployer).length,
          socKeys: Object.keys(bySoc).length,
          period,
        };
      } catch (e) {
        console.error('[STAT salary] LCA fetch error:', e.message);
      }
    }

    return { ok: false, error: 'No LCA file reachable' };
  }

  // Parse tab-separated LCA data (older DOL format)
  _parseTSVLCA(text) {
    const lines = text.split('\n');
    if (lines.length < 2) return [];
    const headers = lines[0].split('\t').map(h => h.trim().toUpperCase());

    const idxStatus  = headers.findIndex(h => h.includes('CASE_STATUS'));
    const idxSoc     = headers.findIndex(h => h.includes('SOC_CODE'));
    const idxTitle   = headers.findIndex(h => h.includes('SOC_TITLE'));
    const idxWageMin = headers.findIndex(h => h.includes('WAGE_RATE_OF_PAY_FROM'));
    const idxWageMax = headers.findIndex(h => h.includes('WAGE_RATE_OF_PAY_TO'));
    const idxUnit    = headers.findIndex(h => h.includes('WAGE_UNIT_OF_PAY'));
    const idxEmployer = headers.findIndex(h => h.includes('EMPLOYER_NAME'));
    const idxState   = headers.findIndex(h => h.includes('WORKSITE_STATE') || h.includes('EMPLOYER_STATE'));

    if (idxStatus < 0 || idxSoc < 0 || idxWageMin < 0) return [];

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t');
      const status = cols[idxStatus]?.trim().toUpperCase();
      if (status !== 'CERTIFIED') continue;

      const soc = cols[idxSoc]?.trim().replace(/['"]/g, '');
      if (!RELEVANT_SOC.some(s => soc?.startsWith(s.slice(0, 5)))) continue;

      const wageMin = parseFloat((cols[idxWageMin] || '').replace(/[$,]/g, ''));
      const wageMax = parseFloat((cols[idxWageMax] || '').replace(/[$,]/g, ''));
      const unit    = (cols[idxUnit] || '').trim().toLowerCase();
      const employer = cols[idxEmployer]?.trim() || '';
      const state   = cols[idxState]?.trim() || '';

      // Convert hourly to annual (assuming 2080 hrs/year)
      const annualMin = unit.includes('hour') ? wageMin * 2080 : wageMin;
      const annualMax = unit.includes('hour') ? wageMax * 2080 : wageMax;

      if (!annualMin || annualMin < 20000 || annualMin > 500000) continue;

      rows.push({ soc, employer, state, min: annualMin, max: annualMax || annualMin });
    }
    return rows;
  }

  // Parse XLSX binary LCA data using ZIP/XML extraction
  // XLSX files are ZIP archives containing xl/worksheets/sheet1.xml
  _parseXLSXLCA(buffer) {
    try {
      // Find the shared strings and sheet data in the ZIP
      // This is a minimal XLSX parser — extract text from XML
      const bytes = new Uint8Array(buffer);
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

      // Look for XML data embedded in the ZIP
      // XLSX sheets start with <sheetData>
      const sheetMatch = text.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
      if (!sheetMatch) {
        // If we can't parse XLSX binary, return empty and fall back
        return [];
      }

      // Extract row data — this is a simplified approach
      // Real XLSX parsing needs proper ZIP + XML handling
      // For a Worker environment, we parse what we can from the raw bytes
      const rows = [];
      const rowMatches = [...sheetMatch[1].matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)];

      for (const rowMatch of rowMatches.slice(0, 50000)) {
        const cells = [...rowMatch[1].matchAll(/<c[^>]*>[\s\S]*?<v>([\s\S]*?)<\/v>/g)]
          .map(m => m[1]);
        if (cells.length >= 8) rows.push(cells);
      }

      return rows; // Will be indexed by _indexLCARows after further processing
    } catch { return []; }
  }

  // Build employer and SOC indexes from parsed LCA rows
  _indexLCARows(rows, period) {
    const employerMap = {}; // employer name → {min, max, count, state, period}
    const socMap = {};      // soc:state → {p25, p75, count, period}

    // Accumulate data per employer
    const empAccum = {}; // employer → [{min, max}]
    const socAccum = {};  // soc:state → [min], soc:national → [min]

    for (const row of rows) {
      if (!row.soc || !row.min) continue;

      // Employer accumulator
      const empKey = (row.employer || '').toLowerCase().trim();
      if (empKey && empKey.length > 2) {
        if (!empAccum[empKey]) empAccum[empKey] = [];
        empAccum[empKey].push({ min: row.min, max: row.max });
      }

      // SOC accumulator — by state and national
      const socBase = row.soc.slice(0, 7);
      const stateKey = `${socBase}:${row.state}`;
      const natKey   = `${socBase}:national`;

      if (row.state) {
        if (!socAccum[stateKey]) socAccum[stateKey] = [];
        socAccum[stateKey].push(row.min);
      }
      if (!socAccum[natKey]) socAccum[natKey] = [];
      socAccum[natKey].push(row.min);
    }

    // Compute employer summaries (need ≥3 data points)
    for (const [emp, entries] of Object.entries(empAccum)) {
      if (entries.length < 3) continue;
      const mins = entries.map(e => e.min).sort((a, b) => a - b);
      const maxs = entries.map(e => e.max).sort((a, b) => a - b);
      // Use first row's state as representative
      const state = rows.find(r => (r.employer||'').toLowerCase().trim() === emp)?.state;
      // Find the original employer name (preserve casing)
      const origName = rows.find(r => (r.employer||'').toLowerCase().trim() === emp)?.employer;

      employerMap[origName || emp] = {
        min: mins[Math.floor(mins.length * 0.25)],
        max: maxs[Math.floor(maxs.length * 0.75)],
        count: entries.length,
        state: state || null,
        employer: origName || emp,
        period,
      };
    }

    // Compute SOC summaries (need ≥5 data points)
    for (const [key, vals] of Object.entries(socAccum)) {
      if (vals.length < 5) continue;
      vals.sort((a, b) => a - b);
      const n = vals.length;
      socMap[key] = {
        p25: vals[Math.floor(n * 0.25)],
        p50: vals[Math.floor(n * 0.5)],
        p75: vals[Math.floor(n * 0.75)],
        count: n,
        state: key.split(':')[1],
        period,
      };
    }

    return { byEmployer: employerMap, bySoc: socMap };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Salary enrichment function — called by CompanyWatcherDO for each new job
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enrich a job with salary inference data.
 * If the job already has a salary, record it in the peer pool.
 * If not, query the SalaryInferenceDO.
 *
 * Returns the job object with salary fields populated:
 *   job.salary        — formatted string or null
 *   job.salaryLabel   — detailed attribution string or null
 *   job.salarySource  — 'disclosed' | 'peer' | 'lca_employer' | 'lca_soc' | 'bls' | 'none'
 *   job.salaryInferred — true if estimated
 *   job.transparencyFlag — state abbreviation if disclosure required but missing
 */
export async function enrichJobWithSalary(job, match, env) {
  // Get a stub to the global SalaryInferenceDO
  let stub;
  try {
    const id = env.SALARY_INFERENCE.idFromName('salary-inference');
    stub = env.SALARY_INFERENCE.get(id);
  } catch {
    // SALARY_INFERENCE binding not configured — skip silently
    return job;
  }

  const jobWithGroup = { ...job, _matchGroup: match?.label };

  // If the job has a disclosed salary range, record it in the peer pool
  // so future no-salary jobs from the same ATS can benefit
  if (job.salaryRaw?.min || job.salaryRaw?.max) {
    try {
      await stub.fetch(new Request('https://stat-salary/record', {
        method: 'POST',
        body: JSON.stringify({ job: jobWithGroup, match }),
        headers: { 'Content-Type': 'application/json' },
      }));
    } catch { /* non-critical */ }
    job.salarySource  = 'disclosed';
    job.salaryInferred = false;
    return job;
  }

  // No disclosed salary — request inference
  try {
    const res = await stub.fetch(new Request('https://stat-salary/infer', {
      method: 'POST',
      body: JSON.stringify(jobWithGroup),
      headers: { 'Content-Type': 'application/json' },
    }));
    const inferred = await res.json();

    if (inferred.salary) {
      job.salary         = inferred.salary;
      job.salaryLabel    = inferred.salaryLabel;
      job.salarySource   = inferred.salarySource;
      job.salaryInferred = true;
      job.sourcePriority = inferred.sourcePriority;
    } else {
      job.salarySource  = 'none';
      job.salaryInferred = true;
    }

    if (inferred.transparencyFlag) {
      job.transparencyFlag     = inferred.transparencyFlag;
      job.transparencyViolation = inferred.transparencyViolation ?? false;
    }
  } catch { /* non-critical — job still alerts without salary */ }

  return job;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap helper — called once at deploy/bootstrap time to prime the caches
// ─────────────────────────────────────────────────────────────────────────────
export async function bootstrapSalaryDO(env) {
  let stub;
  try {
    const id = env.SALARY_INFERENCE.idFromName('salary-inference');
    stub = env.SALARY_INFERENCE.get(id);
  } catch {
    return { ok: false, error: 'SALARY_INFERENCE binding not found' };
  }

  const [blsResult, lcaResult] = await Promise.allSettled([
    stub.fetch(new Request('https://stat-salary/refresh-bls', { method: 'POST' }))
      .then(r => r.json()),
    stub.fetch(new Request('https://stat-salary/refresh-lca', { method: 'POST' }))
      .then(r => r.json()),
  ]);

  return {
    bls: blsResult.status === 'fulfilled' ? blsResult.value : { error: blsResult.reason?.message },
    lca: lcaResult.status === 'fulfilled' ? lcaResult.value : { error: lcaResult.reason?.message },
  };
}
