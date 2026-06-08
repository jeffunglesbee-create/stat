/**
 * STAT — ATS Adapters
 * One fetchJobs(company, env) function per ATS platform.
 * Each returns Array<NormalizedJob> or [].
 * All errors are caught internally — callers never throw.
 */

import { GHOST } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared types (JSDoc)
// NormalizedJob: { id, title, company, location, environment, salary,
//                  url, postedAt, postedDaysAgo, ghostFlag, matchedKeyword }
// ─────────────────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─────────────────────────────────────────────────────────────────────────────
// Ghost age analysis
// Returns { daysAgo: number|null, ghostFlag: string|null }
// ghostFlag values: null (fine) | 'warn' (old, verify) | 'suppress' (too old)
// ─────────────────────────────────────────────────────────────────────────────
export function analyzeAge(postedAt) {
  if (!postedAt) return { daysAgo: null, ghostFlag: null };
  const posted = new Date(postedAt);
  if (isNaN(posted.getTime())) return { daysAgo: null, ghostFlag: null };
  const daysAgo = Math.floor((Date.now() - posted.getTime()) / 86_400_000);
  let ghostFlag = null;
  if (daysAgo >= GHOST.suppress_after_days) ghostFlag = 'suppress';
  else if (daysAgo >= GHOST.warn_after_days) ghostFlag = 'warn';
  return { daysAgo, ghostFlag };
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalize helpers
// ─────────────────────────────────────────────────────────────────────────────
function normalizeEnv(raw) {
  if (!raw) return '';
  const s = String(raw).toLowerCase();
  if (s.includes('remote')) return 'remote';
  if (s.includes('hybrid')) return 'hybrid';
  if (s.includes('onsite') || s.includes('on-site') || s.includes('in-office')) return 'onsite';
  return s;
}

function normalizeSalary(min, max) {
  if (!min && !max) return null;
  const fmt = (n) => n >= 1000 ? `$${(n / 1000).toFixed(0)}k` : `$${n}`;
  if (min && max) return `${fmt(min)}–${fmt(max)}`;
  if (min) return `${fmt(min)}+`;
  return null;
}

function makeJob(fields) {
  const { daysAgo, ghostFlag } = analyzeAge(fields.postedAt);
  return {
    id:           String(fields.id ?? ''),
    title:        fields.title ?? 'Unknown Title',
    company:      fields.company ?? 'Unknown Company',
    location:     fields.location ?? '',
    environment:  normalizeEnv(fields.environment),
    salary:       fields.salary ?? null,
    salaryRaw:    fields.salaryRaw ?? null,  // {min, max} numbers — required for peer pool recording
    url:          fields.url ?? '',
    postedAt:     fields.postedAt ?? null,
    daysAgo,
    ghostFlag,    // null | 'warn' | 'suppress'
    matchedKeyword: null, // set by matcher
    atsSource:    fields.atsSource ?? 'unknown',
    description:  fields.description ?? '', // body text where available (GH/Lever/Ashby)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GREENHOUSE
// Public API — no auth required
// https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchGreenhouse(company) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${company.token}/jobs?content=true`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return [];
    const data = await res.json();
    const jobs = data.jobs ?? [];
    return jobs.map(j => makeJob({
      id:          j.id,
      title:       j.title,
      company:     company.name,
      location:    j.location?.name ?? j.offices?.[0]?.name ?? '',
      environment: j.metadata?.find(m => m.name?.toLowerCase().includes('remote'))?.value
                   ?? (j.location?.name?.toLowerCase().includes('remote') ? 'remote' : ''),
      salary:      normalizeSalary(
                     j.metadata?.find(m => m.name?.toLowerCase().includes('salary'))?.value,
                     null
                   ),
      url:         j.absolute_url ?? `https://boards.greenhouse.io/${company.token}/jobs/${j.id}`,
      postedAt:    j.updated_at ?? null,
      atsSource:   'greenhouse',
      description: j.content ?? '', // returned when ?content=true
    }));
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// LEVER
// Public API — no auth required
// https://api.lever.co/v0/postings/{token}?mode=json
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchLever(company) {
  const url = `https://api.lever.co/v0/postings/${company.token}?mode=json&limit=250`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return [];
    const jobs = await res.json();
    if (!Array.isArray(jobs)) return [];
    return jobs.map(j => makeJob({
      id:          j.id,
      title:       j.text,
      company:     company.name,
      location:    j.categories?.location ?? j.categories?.allLocations?.[0] ?? '',
      description: j.description?.content ?? j.descriptionBody?.content ?? '',
      environment: j.categories?.commitment?.toLowerCase().includes('remote') ? 'remote'
                   : j.categories?.location?.toLowerCase().includes('remote') ? 'remote'
                   : '',
      salary:      normalizeSalary(j.salaryRange?.min, j.salaryRange?.max),
      salaryRaw:   (j.salaryRange?.min || j.salaryRange?.max) ? { min: j.salaryRange?.min ?? null, max: j.salaryRange?.max ?? null } : null,
      url:         j.hostedUrl ?? `https://jobs.lever.co/${company.token}/${j.id}`,
      postedAt:    j.createdAt ? new Date(j.createdAt).toISOString() : null,
      atsSource:   'lever',
    }));
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// ASHBY
// Public API — no auth required
// https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchAshby(company) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${company.token}?includeCompensation=true`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return [];
    const data = await res.json();
    const jobs = data.jobs ?? [];
    return jobs.map(j => makeJob({
      id:          j.id,
      title:       j.title,
      company:     company.name,
      location:    j.location ?? '',
      environment: j.workplaceType?.toLowerCase() ?? '',
      description: j.jobDescription?.descriptionHtml ?? j.jobDescription?.description ?? '',
      salary:      j.compensation?.summaryComponents?.[0]
                   ? `${j.compensation.summaryComponents[0].label}: ${j.compensation.summaryComponents[0].value}`
                   : null,
      url:         j.jobUrl ?? '',
      postedAt:    j.publishedAt ?? null,
      atsSource:   'ashby',
    }));
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKDAY
// SSR payload — extract __NEXT_DATA__ or Workday JSON from page HTML.
// URL varies per tenant (provided in company.url).
// Workday also exposes a search API at /wday/cxs/{tenant}/{path}/jobs
// We try the JSON search endpoint first, fall back to SSR parse.
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchWorkday(company, env) {
  if (!company.url) return [];

  // ─────────────────────────────────────────────────────────────────────────
  // ROOT CAUSE (confirmed 2026-06-07, sessions 4–5):
  //
  // Workday's /wday/cxs/ JSON API requires a valid browser session established
  // by a prior page load. From Workday's own cookie documentation:
  //   - PLAY_SESSION: session ID — must be present on all API calls
  //   - CALYPSO_CSRF_TOKEN: CSRF token — required, causes 422 if absent
  //   - __cf_bm: Cloudflare bot management cookie — set on first page load
  //   - WorkdayLB_*: load balancer stickiness cookies
  //
  // Plain fetch() from any datacenter IP (Cloudflare Worker, GitHub Actions)
  // returns HTTP 422 because these cookies are absent. This is not an IP block;
  // it is correct, documented CSRF/session validation behavior.
  //
  // SOLUTION: Browser Rendering (env.MYBROWSER) loads the career page in a
  // real headless Chrome session. Workday's JavaScript executes, sets all
  // required cookies, then fires the /wday/cxs/ XHR automatically. We
  // intercept that XHR response via page.on('response') and extract the
  // jobPostings JSON — no manual cookie extraction, no CSRF token handling.
  //
  // This is the same XHR intercept pattern used by fetchHiringCafeBR().
  // Cost: ~3-5s browser time per company. Workers Paid includes 10 hrs/month
  // free, sufficient for normal STAT polling volumes.
  // ─────────────────────────────────────────────────────────────────────────

  // Attempt 1: Browser Rendering XHR intercept
  // Requires env.MYBROWSER (Workers Plus binding). Falls through if unavailable.
  if (env?.MYBROWSER) {
    let browser = null;
    let page = null;
    try {
      // SESSION REUSE — connect to idle browser, launch only if none available
      const sessions = await puppeteer.sessions(env.MYBROWSER);
      const idle = sessions.filter(s => !s.connectionId);
      if (idle.length > 0) {
        try {
          browser = await puppeteer.connect(env.MYBROWSER, idle[0].sessionId);
        } catch { browser = null; }
      }
      // DataImpulse residential proxy — bypasses Workday's __cf_bm bot detection
      // which blocks headless Chrome from CF datacenter IPs.
      // Chrome handles CONNECT tunneling natively via --proxy-server arg.
      // page.authenticate() provides username:password to the proxy gateway.
      // When DI creds absent, launch normally (CF IP — intercept works for
      // some tenants whose __cf_bm is less strict).
      const diUser = env?.DATAIMPULSE_USER;
      const diPass = env?.DATAIMPULSE_PASS;
      const proxyArgs = (diUser && diPass)
        ? ['--proxy-server=gw.dataimpulse.com:823']
        : [];
      if (!browser) browser = await puppeteer.launch(env.MYBROWSER, {
        args: proxyArgs,
      });

      page = await browser.newPage();

      // Authenticate with DataImpulse proxy gateway (no-op when no proxy)
      if (diUser && diPass) {
        await page.authenticate({ username: diUser, password: diPass });
      }

      // RESOURCE BLOCKING + SEARCH INJECTION
      // Two purposes:
      // 1. Abort non-essential resources to reduce browser time cost
      // 2. Intercept the /wday/cxs/ POST and inject searchText:'epic'
      //    The SPA fires searchText:"" by default (all jobs, all categories).
      //    Rewriting to searchText:'epic' filters server-side — only Epic roles
      //    are returned, eliminating noise from nursing/facilities/food service.
      //    limit:20 is the Workday hard cap (jobhive confirmed — >20 returns 400).
      await page.setRequestInterception(true);
      page.on('request', req => {
        const t = req.resourceType();
        if (['image', 'font', 'media', 'stylesheet'].includes(t)) {
          req.abort();
          return;
        }
        // Inject searchText:'epic' into the Workday jobs search XHR
        if (req.url().includes('/wday/cxs/') && req.method() === 'POST') {
          try {
            const body = JSON.parse(req.postData() || '{}');
            body.searchText = 'epic';
            body.limit = 20;
            req.continue({
              postData: JSON.stringify(body),
              headers: { ...req.headers(), 'Content-Type': 'application/json' },
            });
            return;
          } catch { /* parse failed — let it through unmodified */ }
        }
        req.continue();
      });

      // XHR INTERCEPT — capture the /wday/cxs/ response fired by Workday SPA
      // After page load, Workday JS executes and fires the jobs search XHR.
      // The browser carries all session cookies automatically (PLAY_SESSION,
      // CALYPSO_CSRF_TOKEN, __cf_bm, WorkdayLB_*) — no manual handling needed.
      let capturedJobs = null;
      const xhrPromise = new Promise((resolve) => {
        page.on('response', async (response) => {
          if (capturedJobs !== null) return;
          if (!response.url().includes('/wday/cxs/')) return;
          if (!response.url().includes('/jobs')) return;
          try {
            const data = await response.json();
            const postings = data?.jobPostings;
            if (Array.isArray(postings)) {
              capturedJobs = postings;
              resolve(postings);
            }
          } catch {}
        });
      });

      await page.goto(company.url, {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      });

      // Wait for XHR response OR 15s timeout — whichever comes first
      // Workday SPA fires the XHR ~1-3s after domcontentloaded
      const postings = await Promise.race([
        xhrPromise,
        new Promise(r => setTimeout(() => r(null), 15_000)),
      ]);

      await page.close();
      page = null;
      await browser.disconnect();
      browser = null;

      if (postings && postings.length > 0) {
        const parsed = new URL(company.url);
        console.log(`[STAT Workday-BR] ${company.name}: ${postings.length} jobs via XHR intercept`);
        const brJobs = postings.map(j => makeJob({
          id:          j.bulletFields?.[0] ?? j.externalPath ?? Math.random().toString(36),
          title:       j.title ?? '',
          company:     company.name,
          location:    j.locationsText ?? j.bulletFields?.[1] ?? '',
          environment: (() => {
            const loc = (j.locationsText ?? '').toLowerCase();
            if (loc.includes('remote')) return 'remote';
            if (loc.includes('hybrid')) return 'hybrid';
            return '';
          })(),
          salary:      null,
          url:         j.externalPath ? `${parsed.origin}${j.externalPath}` : company.url,
          postedAt:    j.postedOn ?? null,
          atsSource:   'workday',
        }));
        brJobs._source = 'intercept';
        return brJobs;
      }
      // XHR returned 0 jobs or timed out — fall through to SSR
      console.warn(`[STAT Workday-BR] ${company.name}: XHR intercept returned no jobs — falling through to SSR`);

    } catch (e) {
      console.warn('[STAT Workday-BR]', company.name, e.message);
    } finally {
      if (page) { try { await page.close(); } catch {} }
      if (browser) { try { await browser.disconnect(); } catch {} }
    }
  }

  // Attempt 2: SSR plain fetch — parses job data embedded in server-rendered HTML.
  // Works when the page includes job data in __NEXT_DATA__ or window.__reactiveStore.
  // seenCount=814 confirms this path is returning real job objects (2026-06-07).
  // Does NOT use the /wday/cxs/ API — no CSRF/session requirement.
  try {
    const res = await fetch(company.url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return [];
    const html = await res.text();

    // Try __NEXT_DATA__ first (some Workday deployments use Next.js)
    const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextMatch) {
      const data = JSON.parse(nextMatch[1]);
      const jobs = data?.props?.pageProps?.jobs
                ?? data?.props?.pageProps?.jobPostings
                ?? [];
      if (jobs.length > 0) {
        const r = jobs.map(j => makeJob({
        id:         j.id ?? j.jobId ?? String(Math.random()),
        title:      j.title ?? j.jobTitle ?? '',
        company:    company.name,
        location:   j.location ?? j.locationDisplay ?? '',
        environment: normalizeEnv(j.workplaceType ?? j.locationsText ?? ''),
        salary:     null,
        url:        j.url ?? j.externalPath ?? company.url,
        postedAt:   j.postedOn ?? j.postedAt ?? null,
        atsSource:  'workday',
        }));
        r._source = 'ssr_next';
        return r;
      }
    }

    // Try inline JSON blob (Workday embeds job data as a JS variable)
    const inlineMatch = html.match(/window\.__reactiveStore\s*=\s*({[\s\S]*?});\s*<\/script>/);
    if (inlineMatch) {
      const data = JSON.parse(inlineMatch[1]);
      const jobs = data?.jobPostings ?? data?.jobs ?? [];
      if (jobs.length > 0) {
        const rStore = jobs.map(j => makeJob({
        id:         j.bulletFields?.[0] ?? String(Math.random()),
        title:      j.title ?? '',
        company:    company.name,
        location:   j.locationsText ?? '',
        environment: normalizeEnv(j.locationsText ?? ''),
        salary:     null,
        url:        j.externalPath ? `${new URL(company.url).origin}${j.externalPath}` : company.url,
        postedAt:   j.postedOn ?? null,
        atsSource:  'workday',
        }));
        rStore._source = 'ssr_store';
        return rStore;
      }
    }
  } catch { /* give up */ }

  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// iCIMS
// Fastest path: sitemap.xml (returns all jobs with lastmod timestamps)
// Fallback: HTML search page parse
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchICIMS(company) {
  // iCIMS two-step plain fetch() adapter.
  // Verified 2026-06-06: Cloudflare Worker IPs are NOT blocked on plain fetch().
  // The prior 403/timeout was specific to Browser Rendering (headless Chromium).
  //
  // STEP 1 — Search page with ?in_iframe=1
  //   URL: {tenant}.icims.com/jobs/search?ss=1&searchKeyword=&in_iframe=1
  //   Returns: iCIMS portal HTML (not the branded wrapper site).
  //   Contains: job IDs embedded in the page source (42KB, 8+ jobs confirmed).
  //   Extraction: /jobs/(\d{4,6})/ pattern from raw HTML.
  //
  // STEP 2 — Job detail with ?in_iframe=1
  //   URL: {tenant}.icims.com/jobs/{id}/job?in_iframe=1
  //   Returns: server-rendered iCIMS job detail HTML (32KB).
  //   Contains: job title in <title>, description in body text.
  //   Used by enrich.js for second-pass description fetch.
  //
  // Apply URL: {tenant}.icims.com/jobs/{id}/{slug} (no in_iframe — for candidates)

  if (!company.url) return [];

  try {
    // Derive base URL from the configured tenant URL
    const base = company.url.replace(/\/jobs\/.*$/, '').replace(/\/$/, '');

    // STEP 1: fetch search page in_iframe=1 to get current job IDs
    // iCIMS supports searchKeyword param — search for Epic directly
    const searchUrl = base + '/jobs/search?ss=1&searchKeyword=epic&in_iframe=1';
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent':      UA,
        'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control':   'no-cache',
      },
      redirect: 'follow',
    });

    if (!res.ok) return [];

    const html = await res.text();

    // Extract unique job IDs from /jobs/{id}/ URL patterns in the HTML
    const idMatches = [...html.matchAll(/\/jobs\/(\d{4,6})\//g)];
    const jobIds    = [...new Set(idMatches.map(m => m[1]))];

    if (!jobIds.length) return [];

    // Build job objects from IDs
    // Title/location come from the detail page (enrich.js second pass)
    // For the list-level object, extract title from the href text if present
    const hrefPattern = /href="\/jobs\/(\d{4,6})\/([^"?]+)"/g;
    const slugMap = {};
    for (const m of html.matchAll(hrefPattern)) {
      slugMap[m[1]] = m[2]; // id -> slug
    }

    return jobIds.map(id => {
      const slug    = slugMap[id] ?? 'job';
      const applyUrl = base + '/jobs/' + id + '/' + slug;

      return makeJob({
        id,
        title:       '',          // populated by enrich.js second-pass
        company:     company.name,
        location:    '',          // populated by enrich.js second-pass
        environment: '',
        salary:      null,
        url:         applyUrl,
        postedAt:    null,
        atsSource:   'icims',
        description: '',          // populated by enrich.js second-pass
      });
    });

  } catch { return []; }
}


// ─────────────────────────────────────────────────────────────────────────────
// SAP SUCCESSFACTORS
// Public XML feed — no auth required.
//
// Verified endpoint (SAP KBA 2428902 + probe confirmed 2026-06-06):
//   https://career4.successfactors.com/career?company={id}&career_ns=job_listing_summary&resultType=XML
//
// Verified XML structure from Hopkins SFHUP feed (8MB, ~1000+ jobs):
//   <Job-Listing>
//     <Job>
//       <JobTitle><![CDATA[...]]></JobTitle>
//       <ReqId>669439</ReqId>         ← unique job ID
//       <Job-Description><![CDATA[full HTML description]]></Job-Description>
//       <filter1> <label>Job Category</label> <value>...</value> </filter1>
//       <filter2> <label>Affiliate</label>    <value>...</value> </filter2>
//       <filter3> <label>Shift</label>        <value>...</value> </filter3>
//       <filter7> <label>Location</label>     <value>City, ST</value> </filter7>
//       <filter8> <label>Work Setting</label> <value>Hybrid|On-site|Remote</value> </filter8>
//       <filter10><label>Job Status</label>   <value>Full Time|Part Time</value></filter10>
//     </Job>
//   </Job-Listing>
//
// Job apply URL constructed from: company.url base + reqId
//   career4.successfactors.com/career?company={id}&career_job_req_id={reqId}&career_ns=job_listing&navBarLevel=JOB_SEARCH
//
// ─────────────────────────────────────────────────────────────────────────────
// SuccessFactors: XML feed contains all jobs. matchJob() filters client-side.
// SF feeds are typically small (<100 jobs) so full fetch is acceptable.
export async function fetchSuccessFactors(company) {
  if (!company.url) return [];
  try {
    const res = await fetch(company.url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/xml,application/xml,*/*;q=0.9' },
    });
    if (!res.ok) return [];
    const xml = await res.text();

    // Parse <Job> blocks — the verified SF XML root element
    const jobMatches = [...xml.matchAll(/<Job>([\s\S]*?)<\/Job>/g)];
    if (!jobMatches.length) return [];

    // Extract company ID from URL for building apply links
    const companyId = new URL(company.url).searchParams.get('company') ?? company.token ?? '';
    const sfBase    = 'https://career4.successfactors.com/career?company=' + companyId;

    return jobMatches.map(m => {
      const block = m[1];
      const cdata = (tag) => {
        const m2 = block.match(new RegExp('<' + tag + '[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></' + tag + '>'));
        return m2 ? m2[1].trim() : '';
      };
      const plain = (tag) => {
        const m2 = block.match(new RegExp('<' + tag + '[^>]*>([^<]*)</' + tag + '>'));
        return m2 ? m2[1].trim() : '';
      };
      const filterVal = (num) => {
        const m2 = block.match(new RegExp('<filter' + num + '>[\\s\\S]*?<value>([^<]*)</value>[\\s\\S]*?</filter' + num + '>'));
        return m2 ? m2[1].trim() : '';
      };

      const title       = cdata('JobTitle') || plain('JobTitle');
      const reqId       = plain('ReqId');
      const descRaw = cdata('Job-Description');
      // SF XML descriptions contain HTML + literal \r\n sequences — strip both
      const description = descRaw
        .replace(/\\r\\n/g, ' ').replace(/\\n/g, ' ').replace(/\\r/g, ' ')
        .replace(/&#?[a-zA-Z0-9]+;/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ').trim();
      const location    = filterVal(7);   // "City, ST"
      const workSetting = filterVal(8);   // "Hybrid|On-site: 90-100%|Remote"
      const affiliate   = filterVal(2);   // "Johns Hopkins Hospital" etc.

      // Build apply URL using reqId
      const applyUrl = reqId
        ? sfBase + '&career_job_req_id=' + reqId + '&career_ns=job_listing&navBarLevel=JOB_SEARCH'
        : sfBase;

      // Normalise environment from Work Setting field (more reliable than location)
      const envRaw = workSetting.toLowerCase();
      const environment = envRaw.includes('remote')  ? 'remote'
                        : envRaw.includes('hybrid')  ? 'hybrid'
                        : envRaw.includes('on-site') ? 'onsite'
                        : '';

      return makeJob({
        id:          reqId || ('sf-' + company.token + '-' + Math.random().toString(36).slice(2)),
        title,
        company:     affiliate || company.name,
        location,
        environment,
        salary:      null,
        url:         applyUrl,
        postedAt:    null,     // SF XML feed does not include post date
        atsSource:   'successfactors',
        description,           // FULL HTML description — no second-pass fetch needed!
      });
    });
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// ORACLE TALEO
// HTML parse of the job search page
// URL pattern: {company}.taleo.net/careersection/{n}/jobsearch.ftl
//
// ARCHITECTURE (verified Session Part 1, 2026-06-06):
//   SEARCH page (/jobsearch.ftl): JavaScript SPA — job data loaded via XHR after
//     JS executes. Plain fetch() returns the shell HTML with no job data.
//     Browser Rendering renders the SPA and extracts job IDs from the DOM.
//     Confirmed: BR returns 20 real job detail URLs from TUHS in ~3.8s.
//
//   DETAIL page (/jobdetail.ftl?job={id}): SERVER-RENDERED HTML — full job
//     description in DOM body text. Plain fetch() works, confirmed 200 + body.
//     og:description is boilerplate ("Click the link...") — use body text.
//
// env.MYBROWSER must be passed in for Browser Rendering.
// Falls back to [] if MYBROWSER is unavailable.
// ─────────────────────────────────────────────────────────────────────────────
import puppeteer from '@cloudflare/puppeteer';

export async function fetchTaleo(company, env) {
  if (!company.url) return [];
  if (!env?.MYBROWSER) {
    // No Browser Rendering available — Taleo SPA cannot be parsed without it
    console.warn('[STAT Taleo] MYBROWSER not available — skipping', company.name);
    return [];
  }

  let browser = null;
  try {
    const base = new URL(company.url).origin;
    const searchUrl = company.url; // /careersection/{n}/jobsearch.ftl

    // Step 1: Use Browser Rendering to render the SPA and extract job IDs
    // Session Part 1 confirmed: BR extracts 20 real jobdetail.ftl?job={id} links
    const sessions = await puppeteer.sessions(env.MYBROWSER);
    const idle = sessions.filter(s => !s.connectionId);
    if (idle.length > 0) {
      try { browser = await puppeteer.connect(env.MYBROWSER, idle[0].sessionId); } catch {}
    }
    if (!browser) browser = await puppeteer.launch(env.MYBROWSER);

    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', req => {
      const t = req.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(t)) req.abort();
      else req.continue();
    });

    await page.goto(searchUrl, { waitUntil: 'networkidle0', timeout: 15_000 });

    // Extract job IDs from rendered DOM — jobdetail.ftl?job={id} links
    const jobLinks = await page.evaluate(() => {
      return [...document.querySelectorAll('a[href]')]
        .map(a => a.href)
        .filter(h => h.includes('jobdetail') && h.includes('job='))
        .slice(0, 50);
    });
    await page.close();
    await browser.disconnect();
    browser = null;

    if (jobLinks.length === 0) return [];

    // Step 2: Plain fetch() each detail page — server-rendered HTML
    // og:description is boilerplate; real description is in body text (enrich.js handles)
    const jobs = [];
    for (const link of jobLinks) {
      try {
        const jobIdMatch = link.match(/[?&]job=(\d+)/);
        if (!jobIdMatch) continue;
        const jobId = jobIdMatch[1];

        // Build the detail URL with the same careersection path
        const detailUrl = link.startsWith('http') ? link
          : base + link;

        const res = await fetch(detailUrl, {
          headers: { 'User-Agent': UA, 'Accept': 'text/html' },
          redirect: 'follow',
        });
        if (!res.ok) continue;
        const html = await res.text();

        // Extract title from <title> tag
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const rawTitle = titleMatch?.[1]?.trim() ?? '';
        // Taleo titles: "Job Description - {Title} = {Campus}" or just the title
        const title = rawTitle.replace(/^Job Description\s*[-–]\s*/i, '').replace(/=.*$/, '').trim();

        // Extract location from structured data or meta tags
        const locMatch = html.match(/class="[^"]*location[^"]*"[^>]*>([^<]+)</i)
                      || html.match(/<span[^>]*>([^<]*,\s*[A-Z]{2}[^<]*)<\/span>/);
        const location = locMatch?.[1]?.trim() ?? '';

        // Extract posted date if present
        const dateMatch = html.match(/(?:posted|opening date)[^>]*>([^<]+)</i);
        const postedAt = dateMatch?.[1]?.trim() ?? null;

        jobs.push(makeJob({
          id:          'taleo:' + jobId,
          title,
          company:     company.name,
          location,
          environment: '',   // populated by enrich.js description fetch
          salary:      null,
          url:         detailUrl,
          postedAt,
          atsSource:   'taleo',
          description: '',   // populated by enrich.js (BR handles Taleo detail pages)
        }));

        await new Promise(r => setTimeout(r, 200)); // polite delay
      } catch (e) {
        console.warn('[STAT Taleo] detail fetch failed:', e.message);
      }
    }
    return jobs;

  } catch (e) {
    console.warn('[STAT Taleo] fetchTaleo error:', company.name, e.message);
    if (browser) { try { await browser.disconnect(); } catch {} }
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HIRINGCAFE
// ─────────────────────────────────────────────────────────────────────────────
// HIRINGCAFE — wide-net scrape with full v5_processed_job_data extraction
//
// The __NEXT_DATA__ SSR payload contains far more than just title/location.
// HiringCafe's AI enrichment layer (v5_processed_job_data) provides:
//   workplace_states          — structured array of approved US states (GOLD)
//   boundless_workplace_states — states where fully remote is approved (GOLD)
//   is_workplace_worldwide_ok  — boolean: truly location-agnostic
//   workplace_type            — 'Remote' | 'Hybrid' | 'Onsite'
//   description               — full HTML job body (from job_information)
//   source + board_token      — original ATS + slug for DO promotion
//   salary fields             — yearly_min/max_compensation (structured)
//   requirements_summary      — AI-generated 1-sentence summary
//   seniority_level           — 'Entry' | 'Mid' | 'Senior' etc.
//   is_compensation_transparent — boolean: salary disclosed
//
// These fields are available at search-results list level (not just detail page)
// so STAT captures them on every HiringCafe scrape with zero extra HTTP requests.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// HIRINGCAFE — BROWSER RENDERING (FAST XHR INTERCEPT)
// Novel approach: intercept the ES search XHR directly instead of waiting
// for full page render. Session reuse + resource blocking + fast exit.
//
// MITIGATIONS vs call frequency + cost concerns:
//   1. Adaptive frequency: 0 matches → 10min backoff, 1+ → 1min
//   2. Session reuse: connect to idle browser (~50ms) vs cold launch (~800ms)
//   3. waitForResponse not networkidle0: ~1.2s vs ~4s per call
//   4. Resource blocking: abort images/fonts/media/stylesheets
//   5. Disconnect not close: browser stays warm between calls
//   6. finally block: always disconnect, never leave hanging session
//
// Cost at 2 calls/min: ~1.6s/call × 2 × 60 = 192s/hr = 3.2 hrs/day = 96 hrs/mo
// With adaptive backoff (avg 10min between calls): 2s/10min = ~0.2 hrs/day = 6 hrs/mo
// Workers Paid includes 10 hrs/mo FREE — stays well within free tier.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Shared HiringCafe hit → job object mapper
// Used by both SSR (fetchHiringCafe) and BR XHR intercept (fetchHiringCafeBR).
// Input: raw ES document from ssrHits array or BR XHR response hits array.
// Both paths return the same v5_processed_job_data + job_information structure.
// ─────────────────────────────────────────────────────────────────────────────
export function mapHiringCafeHit(j) {
  const v5  = j.v5_processed_job_data ?? {};
  const inf = j.job_information ?? {};

  const salMin = v5.yearly_min_compensation ?? v5.monthly_min_compensation * 12
                 ?? v5.hourly_min_compensation * 2080 ?? j.salaryMin ?? null;
  const salMax = v5.yearly_max_compensation ?? v5.monthly_max_compensation * 12
                 ?? v5.hourly_max_compensation * 2080 ?? j.salaryMax ?? null;

  const workplaceStates = v5.workplace_states ?? [];
  const boundlessStates = v5.boundless_workplace_states ?? [];
  const isWorldwide     = v5.is_workplace_worldwide_ok ?? false;
  const workplaceType   = v5.workplace_type ?? j.workplaceType ?? j.workplace_type ?? '';
  const envRaw          = workplaceType || v5.workplace_physical_environment || '';
  const atsSource       = j.source ?? 'hiringcafe';
  const boardToken      = j.board_token ?? '';
  const applyUrl        = j.apply_url ?? j.applicationUrl ?? j.applyUrl
                          ?? `https://hiring.cafe/job/${j.requisition_id ?? j.id}`;
  const description     = inf.description ?? inf.descriptionHtml ?? '';
  const location        = v5.formatted_workplace_location
                          ?? j.location?.display ?? j.locationDisplay ?? j.location ?? '';

  const job = makeJob({
    id:          String(j.id ?? j.requisition_id ?? j.objectID ?? JSON.stringify(j).slice(0, 32)),
    title:       inf.title ?? inf.job_title_raw ?? j.title ?? j.jobTitle ?? '',
    company:     j.enriched_company_data?.name ?? j.company?.name ?? j.companyName ?? '',
    location,
    environment: envRaw,
    salary:      normalizeSalary(salMin, salMax),
    salaryRaw:   (salMin || salMax) ? { min: salMin, max: salMax } : null,
    url:         applyUrl,
    postedAt:    v5.estimated_publish_date ?? j.postedAt ?? j.posted_at ?? null,
    atsSource:   'hiringcafe',
    description,
  });

  job.hc = {
    workplaceStates,
    boundlessStates,
    isWorldwide,
    workplaceType,
    requirementsSummary: v5.requirements_summary ?? '',
    seniorityLevel:      v5.seniority_level ?? '',
    salaryTransparent:   v5.is_compensation_transparent ?? false,
    visaSponsorship:     v5.visa_sponsorship ?? false,
    minYoe:              v5.min_industry_and_role_yoe ?? null,
    certifications:      v5.licenses_or_certifications ?? [],
    technicalTools:      v5.technical_tools ?? [],
    atsSource,
    boardToken,
    requisitionId:       j.requisition_id ?? '',
    companySize:         j.enriched_company_data?.nb_employees ?? null,
    companyFounded:      j.enriched_company_data?.year_founded ?? null,
    companyIndustries:   j.enriched_company_data?.industries ?? [],
  };

  return job;
}

export async function fetchHiringCafeBR(keyword, environment, env) {
  if (!env?.MYBROWSER) return null;

  let browser = null;
  let page = null;

  try {
    // SESSION REUSE — connect to idle browser, launch only if none available
    const sessions = await puppeteer.sessions(env.MYBROWSER);
    const idle = sessions.filter(s => !s.connectionId);
    if (idle.length > 0) {
      try {
        browser = await puppeteer.connect(env.MYBROWSER, idle[0].sessionId);
      } catch { browser = null; }
    }
    if (!browser) browser = await puppeteer.launch(env.MYBROWSER);

    page = await browser.newPage();

    // RESOURCE BLOCKING — abort non-essential requests to speed up JS execution
    await page.setRequestInterception(true);
    page.on('request', req => {
      const t = req.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(t)) req.abort();
      else req.continue();
    });

    // FAST EXIT — capture the ES search XHR response without waiting for full load
    // The HC client-side XHR fires ~400-900ms after domcontentloaded
    // We intercept it and abort the navigation immediately after
    let capturedJobs = null;
    const responsePromise = new Promise((resolve) => {
      page.on('response', async (response) => {
        if (capturedJobs !== null) return;
        const contentType = response.headers()['content-type'] || '';
        if (!contentType.includes('application/json')) return;
        try {
          const text = await response.text();
          // HC search XHR returns JSON with objectID + job_information fields
          if (!text.includes('objectID') || !text.includes('job_information')) return;
          const data = JSON.parse(text);
          const hits = data?.hits?.hits
                    || data?.ssrHits
                    || data?.results
                    || (Array.isArray(data) ? data : null);
          if (hits && hits.length > 0) {
            capturedJobs = hits;
            resolve(hits);
          }
        } catch {}
      });
    });

    const params = new URLSearchParams({ q: keyword, environment });
    await page.goto(`https://hiring.cafe/?${params}`, {
      waitUntil: 'domcontentloaded', // faster than networkidle0
      timeout: 12_000,
    });

    // Wait for XHR response OR 8s timeout — whichever comes first
    const jobs = await Promise.race([
      responsePromise,
      new Promise(r => setTimeout(() => r(null), 8_000)),
    ]);

    await page.close();
    page = null;
    // DISCONNECT not close — browser stays alive (warm session for next call)
    await browser.disconnect();
    browser = null;

    return jobs; // null = BR failed, caller falls back to SSR

  } catch (e) {
    console.warn('[STAT HC-BR] Error:', e.message);
    return null;
  } finally {
    // COST CEILING — always disconnect, never leave a hanging session
    // Un-disconnected sessions burn time until 60s timeout
    if (page) { try { await page.close(); } catch {} }
    if (browser) { try { await browser.disconnect(); } catch {} }
  }
}

// ── buildHcSearchState — construct searchState for HC SSR filtered search ──
// Confirmed 2026-06-08: ?searchState= is processed server-side at SSR time.
// A targeted searchState returns pre-filtered ssrHits (not the global 3.4M feed).
// ssrHits include v5_processed_job_data + enriched_company_data.
// ssrTotalCount reflects filtered count. ssrPageSize=40; paginate via page field.
//
// Probe results: searchState "Epic within", Remote → ssrTotalCount:52, v5:true
// ─────────────────────────────────────────────────────────────────────────────
function buildHcSearchState(keyword, workplaceType, page = 0) {
  return JSON.stringify({
    searchQuery: keyword,
    sortBy: 'date',
    dateFetchedPastNDays: -1,
    locations: [{
      types: ['country'],
      formatted_address: 'United States',
      address_components: [{ long_name: 'United States', short_name: 'US', types: ['country'] }],
      workplace_types: [workplaceType],
      options: {},
      id: `United States_country_${workplaceType}`,
    }],
    higherOrderPrefs: [],
    page,
  });
}

// ── fetchHcPage — fetch one SSR page via searchState ─────────────────────────
async function fetchHcPage(keyword, workplaceType, page = 0) {
  const searchState = buildHcSearchState(keyword, workplaceType, page);
  const url = `https://hiring.cafe/?searchState=${encodeURIComponent(searchState)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  const data = JSON.parse(m[1]);
  return data?.props?.pageProps ?? null;
}

export async function fetchHiringCafe(keyword, environment) {
  // ── searchState SSR filtering (confirmed 2026-06-08) ────────────────────
  // ?searchState= is server-side: returns real keyword-filtered hits with v5.
  // hitsHaveDesc: false — descriptions only on /job/{requisitionId} detail page.
  // Replaces: ?q= and ?environment= which were confirmed no-ops (global feed).
  // ─────────────────────────────────────────────────────────────────────────
  const workplaceType = environment === 'remote' ? 'Remote' : 'Hybrid';
  try {
    const allHits = [];

    // Page 0
    const pp0 = await fetchHcPage(keyword, workplaceType, 0);
    if (!pp0) return [];
    const hits0 = Array.isArray(pp0.ssrHits) ? pp0.ssrHits : [];
    allHits.push(...hits0);

    // Page 1 if more results exist (ssrPageSize=40, ssrIsLastPage flag)
    if (pp0.ssrIsLastPage === false && hits0.length > 0) {
      try {
        const pp1 = await fetchHcPage(keyword, workplaceType, 1);
        if (pp1 && Array.isArray(pp1.ssrHits)) allHits.push(...pp1.ssrHits);
      } catch { /* page 1 failure is non-fatal */ }
    }

    return allHits.map(mapHiringCafeHit);
  } catch { return []; }
}

// ── fetchHcDescription — second-pass fetch for full job description ──────────
// hitsHaveDesc: false (confirmed 2026-06-08) — full HTML description is only
// available on the job detail page: hiring.cafe/job/{requisition_id}
// Call only for jobs that passed v5/keyword match — one fetch per survivor.
// Returns description HTML string, or null on failure.
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchHcDescription(requisitionId) {
  if (!requisitionId) return null;
  try {
    const url = `https://hiring.cafe/job/${requisitionId}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    const data = JSON.parse(m[1]);
    const desc = data?.props?.pageProps?.job?.job_information?.description ?? null;
    return desc || null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher — routes to the right adapter by ATS type
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchCompanyJobs(company, env) {
  switch (company.ats) {
    case 'greenhouse':     return fetchGreenhouse(company);
    case 'lever':          return fetchLever(company);
    case 'ashby':          return fetchAshby(company);
    case 'workday':        return fetchWorkday(company, env);
    case 'icims':          return fetchICIMS(company);
    case 'successfactors': return fetchSuccessFactors(company);
    case 'taleo':          return fetchTaleo(company, env);
    default: return [];
  }
}
// browser rendering + SF fix deployed
