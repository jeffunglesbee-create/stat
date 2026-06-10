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
    // DO-local in-memory L1 cache for R2 salary data.
    // Loaded once per DO instance lifetime. Eliminates repeated R2 reads per /infer call.
    this._r2Cache = { lca_employer: null, lca_soc: null, bls: null };
  }

  // ── R2 helpers ─────────────────────────────────────────────────────────────
  async _r2Get(key) {
    if (!this.env.STAT_R2) return null;
    try {
      const obj = await this.env.STAT_R2.get(key);
      if (!obj) return null;
      return JSON.parse(await obj.text());
    } catch (e) {
      console.warn('[STAT salary] R2 get failed:', key, e.message);
      return null;
    }
  }

  async _r2Put(key, data) {
    if (!this.env.STAT_R2) return;
    try {
      await this.env.STAT_R2.put(key, JSON.stringify(data), {
        httpMetadata: { contentType: 'application/json' },
      });
    } catch (e) {
      console.warn('[STAT salary] R2 put failed:', key, e.message);
    }
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
      const [peerCount, lcaCount, blsDate, lcaDate] = await Promise.all([
        this.storage.get('peer_count'),
        this.storage.get('lca_count'),
        this.storage.get('bls_fetched_at'),
        this.storage.get('lca_fetched_at'),
      ]);
      const r2Bound = !!this.env.STAT_R2;
      // Quick R2 health check — does lca key exist?
      let r2lca = false;
      if (r2Bound) {
        try { r2lca = !!(await this.env.STAT_R2.head('lca-by-employer.json')); } catch {}
      }
      return new Response(JSON.stringify({
        peerCount: peerCount ?? 0,
        lcaCount:  lcaCount  ?? 0,
        blsDate:   blsDate   ?? null,
        lcaDate:   lcaDate   ?? null,
        r2Bound,
        r2lca,
      }));
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
      // L1: DO-local memory cache (loaded once per DO lifetime)
      // L2: R2 processed JSON (written by _refreshLCA)
      // L3: DO storage fallback (backward compat if R2 not populated yet)
      if (!this._r2Cache.lca_employer) {
        this._r2Cache.lca_employer =
          await this._r2Get('lca-by-employer.json') ||
          await this.storage.get('lca_by_employer').then(r => r ? JSON.parse(r) : null);
      }
      const index = this._r2Cache.lca_employer;
      if (!index) return null;

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
      if (!this._r2Cache.lca_soc) {
        this._r2Cache.lca_soc =
          await this._r2Get('lca-by-soc.json') ||
          await this.storage.get('lca_by_soc').then(r => r ? JSON.parse(r) : null);
      }
      const index = this._r2Cache.lca_soc;
      if (!index) return null;

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
      if (!this._r2Cache.bls) {
        this._r2Cache.bls =
          await this._r2Get('bls-wages.json') ||
          await this.storage.get('bls_wages').then(r => r ? JSON.parse(r) : null);
      }
      const index = this._r2Cache.bls;
      if (!index) return null;

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
  // Uses BLS Public Data API v2 (not WAF-blocked, designed for programmatic access).
  // Both www.bls.gov and download.bls.gov block Cloudflare Worker IPs via Akamai WAF.
  // The API endpoint api.bls.gov is not blocked.
  //
  // Series ID format: OE + U(unseasonal) + N(national) + 0000000(area) + 000000(industry)
  //   + 6-digit SOC + 2-digit datatype = 25 chars total
  // e.g. OEUN000000000000015121112 = 15-1211 national p25 annual
  // Datatypes: 11=p10, 12=p25, 13=median, 14=p75, 15=p90
  //
  // No API key: 25 series/request max, 500 queries/day.
  // 4 SOC codes × 5 datatypes = 20 series — within limit.
  // API only returns most recent available year (single-year history).
  async _refreshBLS() {
    const DATATYPES = [
      { code: '11', key: 'p10' },
      { code: '12', key: 'p25' },
      { code: '13', key: 'p50' },
      { code: '14', key: 'p75' },
      { code: '15', key: 'p90' },
    ];

    // Build series IDs and reverse-lookup map
    const seriesIds = [];
    const seriesMap = {};
    for (const soc of RELEVANT_SOC) {
      const socCode = soc.replace('-', '');
      for (const dt of DATATYPES) {
        // OEUN = OE(survey) + U(not seasonal) + N(national area type)
        const sid = `OEUN0000000000000${socCode}${dt.code}`;
        seriesIds.push(sid);
        seriesMap[sid] = { soc, key: dt.key };
      }
    }

    try {
      const res = await fetch('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'STAT/1.0' },
        body: JSON.stringify({ seriesid: seriesIds }),
        // No year range — API returns most recent available year automatically
      });

      if (!res.ok) throw new Error(`BLS API HTTP ${res.status}`);

      const data = await res.json();
      if (data.status !== 'REQUEST_SUCCEEDED') throw new Error(`BLS API: ${data.message?.[0] || data.status}`);
      if (!data.Results?.series) throw new Error('BLS API: no Results.series');

      const wageBySoc = {};
      for (const soc of RELEVANT_SOC) wageBySoc[soc] = {};

      for (const series of data.Results.series) {
        const entry = seriesMap[series.seriesID];
        if (!entry || !series.data?.length) continue;
        // Annual data (period A01); take most recent
        const annual = series.data.filter(d => d.period === 'A01').sort((a, b) => b.year - a.year);
        if (!annual.length) continue;
        const value = parseFloat(annual[0].value);
        if (value > 10000 && value < 1_000_000) {
          wageBySoc[entry.soc][entry.key] = value;
        }
      }

      const results = {};
      let year = new Date().getFullYear().toString();
      // Capture year from first series that returned data
      for (const series of data.Results.series) {
        if (series.data?.length) { year = series.data[0].year; break; }
      }
      for (const soc of RELEVANT_SOC) {
        const w = wageBySoc[soc];
        if (w.p25 && w.p75) {
          results[`${soc}:national`] = { p10: w.p10, p25: w.p25, p50: w.p50,
            p75: w.p75, p90: w.p90, area: 'national', year };
        }
      }

      if (Object.keys(results).length > 0) {
        await Promise.all([
          this._r2Put('bls-wages.json', results),
          this.storage.put('bls_fetched_at', new Date().toISOString()),
        ]);
        this._r2Cache.bls = null;
        return { fetched: Object.keys(results).length, keys: Object.keys(results).length, source: 'bls-api', year };
      }

      return { fetched: 0, keys: 0, error: 'No wage data in API response' };
    } catch (e) {
      console.error('[STAT salary] BLS API error:', e.message);
      return { fetched: 0, keys: 0, error: e.message };
    }
  }

  // ── DOL LCA refresh ───────────────────────────────────────────────────────
  // Downloads and parses DOL OFLC H-1B LCA disclosure data.
  // Format: true XLSX (ZIP of XML files). Current quarters confirmed live:
  //   FY26 Q2: Oct 1 2025 – Mar 31 2026 (released ~Apr 2026)
  //   FY26 Q1: Oct 1 2025 – Dec 31 2025
  //
  // XLSX parsing strategy in Cloudflare Worker (no npm):
  //   1. Fetch as ArrayBuffer
  //   2. Find ZIP local file entries by signature PK\x03\x04
  //   3. For the sheet XML entry (xl/worksheets/sheet1.xml):
  //      - If stored (no compression): read XML directly
  //      - If deflated: use DecompressionStream('deflate-raw') to decompress
  //   4. Parse shared strings (xl/sharedStrings.xml) for text cells
  //   5. Parse sheet rows for wage and employer data
  async _refreshLCA() {
    // DOL uses full 4-digit fiscal year in filenames: FY2026 not FY26.
    // FY2025 Q4 (Oct 2024–Sep 2025) confirmed reachable — use as primary fallback.
    // FY2026 Q1/Q2 added optimistically; may 404 until DOL releases them.
    const candidates = [
      'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2026_Q2.xlsx',
      'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2026_Q1.xlsx',
      'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2025_Q4.xlsx',
      'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2025_Q3.xlsx',
    ];

    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 STAT/1.0' },
        });
        if (!res.ok) continue;

        const period = url.match(/FY(\d+)_Q(\d+)/)?.[0] || 'recent';
        const buf = await res.arrayBuffer();

        // Parse XLSX ZIP using proper ZIP entry extraction
        const rows = await this._parseXLSXProper(buf);

        if (rows.length < 10) {
          console.warn(`[STAT salary] LCA parse returned ${rows.length} rows from ${url}`);
          continue;
        }

        const { byEmployer, bySoc } = this._indexLCARows(rows, period);

        await Promise.all([
          this._r2Put('lca-by-employer.json', byEmployer),
          this._r2Put('lca-by-soc.json', bySoc),
          this.storage.put('lca_count',      rows.length),
          this.storage.put('lca_fetched_at', new Date().toISOString()),
        ]);
        this._r2Cache.lca_employer = null;
        this._r2Cache.lca_soc = null;

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

  // Proper XLSX ZIP parser using ZIP local file header scanning + DecompressionStream
  // XLSX files are ZIP archives. Local file headers: PK\x03\x04 signature.
  // Entry structure: signature(4) + version(2) + flags(2) + compression(2) +
  //                  modtime(2) + moddate(2) + crc32(4) + compressed_size(4) +
  //                  uncompressed_size(4) + filename_len(2) + extra_len(2) +
  //                  filename(variable) + extra(variable) + data(compressed_size)
  async _parseXLSXProper(buffer) {
    try {
      const bytes = new Uint8Array(buffer);
      const view  = new DataView(buffer);

      // Extract all ZIP entries
      const entries = {};
      let pos = 0;

      while (pos < bytes.length - 4) {
        // Find next local file header
        if (bytes[pos] !== 0x50 || bytes[pos+1] !== 0x4B ||
            bytes[pos+2] !== 0x03 || bytes[pos+3] !== 0x04) {
          pos++;
          continue;
        }

        const compression   = view.getUint16(pos + 8,  true); // 0=stored, 8=deflate
        const compressedSz  = view.getUint32(pos + 18, true);
        const fileNameLen   = view.getUint16(pos + 26, true);
        const extraLen      = view.getUint16(pos + 28, true);

        const fileNameBytes = bytes.slice(pos + 30, pos + 30 + fileNameLen);
        const fileName      = new TextDecoder().decode(fileNameBytes);

        const dataStart = pos + 30 + fileNameLen + extraLen;
        const dataEnd   = dataStart + compressedSz;

        // Only extract files we need
        if (fileName === 'xl/sharedStrings.xml' ||
            fileName === 'xl/worksheets/sheet1.xml') {

          const compressedData = bytes.slice(dataStart, dataEnd);

          if (compression === 0) {
            // Stored — no compression
            entries[fileName] = new TextDecoder('utf-8', { fatal: false }).decode(compressedData);
          } else if (compression === 8) {
            // Deflate — use DecompressionStream
            try {
              const ds = new DecompressionStream('deflate-raw');
              const writer = ds.writable.getWriter();
              const reader = ds.readable.getReader();
              writer.write(compressedData);
              writer.close();
              const chunks = [];
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
              }
              const total = chunks.reduce((s, c) => s + c.length, 0);
              const out = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) { out.set(c, off); off += c.length; }
              entries[fileName] = new TextDecoder('utf-8', { fatal: false }).decode(out);
            } catch (decompErr) {
              console.warn('[STAT salary] Decompress error for', fileName, decompErr.message);
            }
          }
        }

        pos = dataEnd;
      }

      if (!entries['xl/worksheets/sheet1.xml']) {
        console.warn('[STAT salary] sheet1.xml not found in XLSX ZIP');
        return [];
      }

      // Parse shared strings (string table for cell values)
      const sharedStrings = [];
      if (entries['xl/sharedStrings.xml']) {
        const siMatches = entries['xl/sharedStrings.xml'].matchAll(/<si>.*?<\/si>/gs);
        for (const m of siMatches) {
          const tMatch = m[0].match(/<t[^>]*>([^<]*)<\/t>/);
          sharedStrings.push(tMatch ? tMatch[1] : '');
        }
      }

      // Parse sheet rows
      const rows = [];
      let headers = null;

      const rowMatches = entries['xl/worksheets/sheet1.xml'].matchAll(/<row[^>]*>(.*?)<\/row>/gs);
      for (const rowMatch of rowMatches) {
        const cells = [];
        const cellMatches = rowMatch[1].matchAll(/<c[^>]*r="([A-Z]+)\d+"[^>]*t="([^"]*)"[^>]*>.*?<v>(.*?)<\/v>/gs);
        const cellMap = {};

        for (const cm of cellMatches) {
          const col  = cm[1];
          const type = cm[2]; // 's' = shared string, '' = number
          let   val  = cm[3];
          if (type === 's') val = sharedStrings[parseInt(val)] || '';
          cellMap[col] = val;
        }

        // Also handle cells without explicit type (numbers)
        const numCellMatches = rowMatch[1].matchAll(/<c[^>]*r="([A-Z]+)\d+"(?![^>]*t=)[^>]*>.*?<v>(.*?)<\/v>/gs);
        for (const cm of numCellMatches) {
          if (!cellMap[cm[1]]) cellMap[cm[1]] = cm[2];
        }

        // Convert column map to array in order
        const colKeys = Object.keys(cellMap).sort();
        const row = colKeys.map(k => cellMap[k]);
        if (row.length === 0) continue;

        if (!headers) {
          headers = row.map(h => String(h).toUpperCase().trim());
          continue;
        }

        if (!headers) continue;
        const rowObj = {};
        headers.forEach((h, i) => { rowObj[h] = row[i] || ''; });
        rows.push(rowObj);

        if (rows.length > 100000) break; // safety cap
      }

      // Convert header-keyed rows to the {soc, employer, state, min, max} format
      const result = [];
      for (const row of rows) {
        const status = (row['CASE_STATUS'] || '').trim().toUpperCase();
        if (status !== 'CERTIFIED' && status !== 'CERTIFIED-WITHDRAWN') continue;

        const soc = (row['SOC_CODE'] || '').trim().replace(/['"]/g, '');
        if (!RELEVANT_SOC.some(s => soc.startsWith(s.slice(0, 5)))) continue;

        const wageMinStr = row['WAGE_RATE_OF_PAY_FROM'] || row['PREVAILING_WAGE'] || '';
        const wageMaxStr = row['WAGE_RATE_OF_PAY_TO']   || '';
        const unit       = (row['WAGE_UNIT_OF_PAY']     || '').toLowerCase();
        const employer   = (row['EMPLOYER_NAME']         || '').trim();
        const state      = (row['WORKSITE_STATE']        || row['EMPLOYER_STATE'] || '').trim();

        const wageMin = parseFloat(wageMinStr.replace(/[$,]/g, ''));
        const wageMax = parseFloat(wageMaxStr.replace(/[$,]/g, ''));

        const annualMin = unit.includes('hour') ? wageMin * 2080 : wageMin;
        const annualMax = unit.includes('hour') ? (wageMax || wageMin) * 2080 : (wageMax || wageMin);

        if (!annualMin || annualMin < 20000 || annualMin > 600000) continue;

        result.push({ soc, employer, state, min: annualMin, max: annualMax });
      }

      return result;
    } catch (e) {
      console.warn('[STAT salary] XLSX parse error:', e.message);
      return [];
    }
  }

  // Legacy tab-separated LCA parser (older DOL format, kept as fallback)
  _parseTSVLCA(text) {
    const lines = text.split('\n');
    if (lines.length < 2) return [];
    const headers = lines[0].split('\t').map(h => h.trim().toUpperCase());

    const idxStatus   = headers.findIndex(h => h.includes('CASE_STATUS'));
    const idxSoc      = headers.findIndex(h => h.includes('SOC_CODE'));
    const idxWageMin  = headers.findIndex(h => h.includes('WAGE_RATE_OF_PAY_FROM'));
    const idxWageMax  = headers.findIndex(h => h.includes('WAGE_RATE_OF_PAY_TO'));
    const idxUnit     = headers.findIndex(h => h.includes('WAGE_UNIT_OF_PAY'));
    const idxEmployer = headers.findIndex(h => h.includes('EMPLOYER_NAME'));
    const idxState    = headers.findIndex(h => h.includes('WORKSITE_STATE') || h.includes('EMPLOYER_STATE'));

    if (idxStatus < 0 || idxSoc < 0 || idxWageMin < 0) return [];

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols   = lines[i].split('\t');
      const status = cols[idxStatus]?.trim().toUpperCase();
      if (status !== 'CERTIFIED') continue;

      const soc = cols[idxSoc]?.trim().replace(/['"]/g, '');
      if (!RELEVANT_SOC.some(s => soc?.startsWith(s.slice(0, 5)))) continue;

      const wageMin  = parseFloat((cols[idxWageMin] || '').replace(/[$,]/g, ''));
      const wageMax  = parseFloat((cols[idxWageMax] || '').replace(/[$,]/g, ''));
      const unit     = (cols[idxUnit] || '').trim().toLowerCase();
      const employer = cols[idxEmployer]?.trim() || '';
      const state    = cols[idxState]?.trim() || '';

      const annualMin = unit.includes('hour') ? wageMin * 2080 : wageMin;
      const annualMax = unit.includes('hour') ? wageMax * 2080 : wageMax;

      if (!annualMin || annualMin < 20000 || annualMin > 500000) continue;

      rows.push({ soc, employer, state, min: annualMin, max: annualMax || annualMin });
    }
    return rows;
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
