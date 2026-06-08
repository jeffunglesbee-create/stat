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
// Confirmed 2026-06-08 via Advocate Health listing page HTML analysis:
//   - ?q=epic on the listing URL triggers SERVER-SIDE rendering of matching
//     job cards. No BR required. No XHR intercept. No CSRF tokens.
//   - Job links pre-rendered as href="/en-US/{board}/job/{loc-slug}/{title-slug}_{ReqID}"
//   - 20 jobs per page. Paginate via ?q=epic&startIndex=20,40,...
//   - Total job count in visible text: "N JOBS FOUND"
//   - detail page: JSON-LD has full description (confirmed MSMC 2026-06-08)
//
// Previous approach: Browser Rendering + DataImpulse proxy + XHR intercept
// (~3-5s, costs BR quota, required proxy creds). Retired 2026-06-08.
//
// URL pattern: https://{tenant}.wd{N}.myworkdayjobs.com/en-US/{board}
// Search:      same URL + ?q=epic&startIndex={offset}
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchWorkday(company, env) {
  if (!company.url) return [];

  try {
    const parsed   = new URL(company.url);
    const origin   = parsed.origin;
    // Build search URL — add ?q=epic to filter server-side
    const searchBase = company.url.split('?')[0];
    const allJobs = [];

    // Paginate: Workday returns 20/page, up to 200 (10 pages)
    for (let offset = 0; offset < 200; offset += 20) {
      const searchUrl = `${searchBase}?q=epic${offset > 0 ? `&startIndex=${offset}` : ''}`;
      const res = await fetch(searchUrl, {
        headers: {
          'User-Agent':      UA,
          'Accept':          'text/html,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
      });
      if (!res.ok) break;
      const html = await res.text();

      // Extract total job count on first page
      if (offset === 0) {
        const totalMatch = html.match(/(\d+)\s+JOBS?\s+FOUND/i);
        const total = totalMatch ? parseInt(totalMatch[1]) : 0;
        if (total === 0) return []; // No Epic jobs at this tenant
      }

      // Extract job links pre-rendered in SSR HTML
      // Pattern: /en-US/{board}/job/{loc-slug}/{title-slug}_{ReqID}
      const links = [...html.matchAll(/href="(\/[\w-]+\/[\w-]+\/job\/([^/]+)\/([^"?]+?)_(R[A-Z0-9]+))[^"]*"/gi)];

      if (links.length === 0) break; // No more pages

      for (const [, fullPath, locSlug, titleSlug, reqId] of links) {
        // Decode title from URL slug
        const title    = titleSlug.replace(/-+/g, ' ').replace(/  +/g, ' ').trim();
        const locRaw   = locSlug.replace(/-{2,}/g, '|').replace(/-/g, ' ').replace(/\|/g, ' - ').trim();

        // Infer environment from location slug
        const environment = /remote/i.test(locSlug) ? 'remote'
                          : /hybrid/i.test(locSlug) ? 'hybrid' : '';

        allJobs.push(makeJob({
          id:          reqId,
          title,
          company:     company.name,
          location:    locRaw,
          environment,
          salary:      null,
          url:         `${origin}${fullPath}`,
          postedAt:    null, // not in listing HTML
          atsSource:   'workday',
          description: '', // enrichDescriptions() fetches via detail page JSON-LD
        }));
      }

      // If we got fewer than 20, we're on the last page
      if (links.length < 20) break;

      // Polite delay between pages
      if (offset + 20 < 200) await new Promise(r => setTimeout(r, 300));
    }

    if (allJobs.length > 0) {
      console.log(`[STAT Workday] ${company.name}: ${allJobs.length} jobs via SSR plain fetch`);
      return allJobs;
    }
  } catch (e) {
    console.warn('[STAT Workday]', company.name, e.message);
  }

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
// ARCHITECTURE (updated 2026-06-08):
//   SEARCH page (/jobsearch.ftl): JavaScript SPA — job data loaded via XHR.
//     Browser Rendering required to render SPA and extract job IDs.
//     Confirmed: BR returns 20 real job detail URLs from TUHS in ~3.8s.
//
//   DETAIL page (/jobdetail.ftl?job={id}): SERVER-RENDERED HTML.
//     Contains hidden <input id="initialHistory"> with ALL job data:
//     URL-encoded, 154+ pipe-delimited (!|!) fields including:
//       field[12] = title
//       field[14] = location (USA-US--Work From Home)
//       field[18] = work location display text
//       field[24] = department
//       field[28] = schedule (Full-Time)
//       fields[34+] = description sections (delimited by !*!)
//       field[39] = salary max (hourly), field[40] = salary min (hourly)
//     og:description is always boilerplate ("Click the link...") — ignore.
//     enrichDescriptions() handles via fetchPlainDescription() — NO BR needed.
//
// BR required: search page (job ID discovery) only.
// BR NOT required: detail page (description + salary extraction).
// env.MYBROWSER must be passed in for BR search page.
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

    // Step 2: Build job objects from BR-extracted links.
    // enrichDescriptions() handles detail page fetch via fetchPlainDescription():
    //   - Decodes initialHistory hidden field (URL-encoded, !|! delimited)
    //   - Extracts title, location, description sections, hourly salary
    //   - Converts hourly × 2080 to annual range
    //   - No BR required for detail pages (confirmed 2026-06-08)
    const jobs = [];
    for (const link of jobLinks) {
      try {
        const jobIdMatch = link.match(/[?&]job=(\d+)/);
        if (!jobIdMatch) continue;
        const jobId = jobIdMatch[1];
        const detailUrl = link.startsWith('http') ? link : base + link;

        // Fetch detail page once to extract title + metadata from initialHistory
        // (enrichDescriptions() would fetch again — do it here to populate title)
        const res = await fetch(detailUrl, {
          headers: { 'User-Agent': UA, 'Accept': 'text/html' },
          redirect: 'follow',
        });
        if (!res.ok) continue;
        const html = await res.text();

        // Parse initialHistory for title, location, salary
        let title = '', location = '', salary = null, salaryRaw = null;
        const histMatch = html.match(/id="initialHistory"\s+value="([^"]{200,})"/i);
        if (histMatch) {
          try {
            const decoded = decodeURIComponent(histMatch[1]);
            const fields = decoded.split('!|!');
            title    = fields[12]?.replace(/<[^>]+>/g, '').trim() ?? '';
            location = (fields[18]?.replace(/<[^>]+>/g, '').trim()
                    || fields[14]?.replace('USA-US--', '').replace(/-/g, ', ').trim()) ?? '';
            // Hourly salary in fields[40] (min) and fields[39] (max)
            const minH = parseFloat(fields[40]);
            const maxH = parseFloat(fields[39]);
            if (!isNaN(minH) && !isNaN(maxH) && minH > 0) {
              const lo = Math.round(minH * 2080);
              const hi = Math.round(maxH * 2080);
              salary    = `$${Math.round(lo/1000)}k\u2013$${Math.round(hi/1000)}k`;
              salaryRaw = { min: lo, max: hi };
            }
          } catch {}
        }

        // Fallback title from <title> tag
        if (!title) {
          const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
          const rawTitle = titleMatch?.[1]?.trim() ?? '';
          title = rawTitle.replace(/^Job Description\s*[-–]\s*/i, '').replace(/=.*$/, '').trim();
        }

        if (!title) continue;

        const environment = location.toLowerCase().includes('remote')
                         || location.toLowerCase().includes('work from home') ? 'remote'
                          : location.toLowerCase().includes('hybrid') ? 'hybrid' : '';

        jobs.push(makeJob({
          id:          'taleo:' + jobId,
          title,
          company:     company.name,
          location,
          environment,
          salary,
          salaryRaw,
          url:         detailUrl,
          postedAt:    null,
          atsSource:   'taleo',
          description: '', // enrichDescriptions() parses initialHistory for description sections
        }));

        await new Promise(r => setTimeout(r, 150)); // polite delay
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

// ORACLE HCM (Fusion Cloud)
// Oracle JET SPA — no Next.js, no JSON-LD, no public REST API.
//
// Confirmed 2026-06-08 via Cedars-Sinai HTML analysis:
//   Framework: Oracle JET with Knockout.js (data-bind="html: pageData().job.description")
//   Description: pre-rendered in class="job-details__description-content" div for SEO
//   Salary: pre-rendered in body text (Minimum Salary / Maximum Salary fields)
//   JSON-LD: ABSENT — Oracle does not emit schema.org/JobPosting
//   REST API: private, not exposed in page HTML
//
// URL structure: {tenant}.fa.{region}.oraclecloud.com/hcmUI/CandidateExperience/en/sites/{siteId}
// Job search URL: .../requisitions?keyword={term}&lastSelectedFacet=SITES&selectedTitleName=...
// Job detail URL: .../job/{jobId}
//
// Search approach: keyword search URL returns pre-rendered job cards in HTML.
// Each card contains title, location, jobId, and apply URL.
// Description fetched separately via job detail page (fetchOracleHcmDescription).
//
// Confirmed companies:
//   Cedars-Sinai: hdkk.fa.us6.oraclecloud.com, site CX_2001
//   Tenet Healthcare: eodr.fa.us2.oraclecloud.com (site TBD — verify with job URL)
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchOracleHcm(company) {
  if (!company.url) return [];
  try {
    const res = await fetch(company.url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    if (!res.ok) return [];
    const html = await res.text();

    // Oracle JET pre-renders job cards in the HTML for SEO/crawlers.
    // Each job card has data-bind attributes but the key data is in
    // structured JSON objects embedded in script tags.
    //
    // Primary path: requisitionsResults JSON in page scripts
    const scriptJson = html.match(/requisitionsResults[\s\S]{0,50}?(\[[\s\S]{100,50000}?\])\s*[,;]/);
    if (scriptJson) {
      try {
        const jobs = JSON.parse(scriptJson[1]);
        return jobs.map(j => _mapOracleJob(j, company)).filter(Boolean);
      } catch {}
    }

    // Fallback: parse job cards from pre-rendered HTML
    // Oracle renders: <div class="job-grid-item" ...> with title, location, jobId
    const cards = [...html.matchAll(/data-job-id="(\d+)"[\s\S]{0,800}?class="[^"]*job-title[^"]*"[^>]*>([^<]+)</g)];
    if (cards.length) {
      return cards.map(([, jobId, title]) => {
        const baseUrl = company.url.split('/requisitions')[0];
        return makeJob({
          id:          `oracle_${company.token}_${jobId}`,
          title:       title.trim(),
          company:     company.name,
          location:    '',
          environment: '',
          salary:      null,
          url:         `${baseUrl}/job/${jobId}`,
          postedAt:    null,
          atsSource:   'oracle_hcm',
          description: '', // enrichDescriptions() fetches via job detail page
        });
      });
    }

    return [];
  } catch { return []; }
}

function _mapOracleJob(j, company) {
  if (!j) return null;
  const baseUrl = (company.url || '').split('/requisitions')[0];
  const jobId = j.Id || j.jobId || j.requisitionId || '';
  const title = j.Title || j.title || j.JobTitle || '';
  const location = j.PrimaryLocation || j.primaryLocation || j.Location || '';
  const remote = (j.WorkFromHome || j.workFromHome || j.RemoteAllowed || '');
  const environment = String(remote).toLowerCase() === 'true' ? 'remote'
    : (location || '').toLowerCase().includes('remote') ? 'remote'
    : '';
  const postedAt = j.PostedDate || j.postedDate || null;

  return makeJob({
    id:          `oracle_${company.token}_${jobId}`,
    title,
    company:     company.name,
    location,
    environment,
    salary:      null,
    url:         jobId ? `${baseUrl}/job/${jobId}` : company.url,
    postedAt:    postedAt ? new Date(postedAt).toISOString() : null,
    atsSource:   'oracle_hcm',
    description: '', // enrichDescriptions() second-pass via job detail page
  });
}

// INFOR CLOUDSUITE HCM
// Angular SPA — Infor Lawson successor, widely used in healthcare for HR/payroll.
// Health systems hire Epic analysts through it.
//
// Confirmed 2026-06-08 via Lee Health HTML analysis:
//   Framework: Angular with Infor Landmark (24 _ngcontent-ng-c* components)
//   Description: pre-rendered in class="lm-richtext-content _op_PositionDescription..."
//   Salary: hourly rate in body text ("$N.NN - $N.NN / hour") — needs × 2080 annual
//   Job ID: in URL params (1000,{jobId},1)
//   JSON-LD: ABSENT. Meta OG tags: ABSENT.
//
// URL structure:
//   Tenant: css-{slug}-prd.inforcloudsuite.com
//   Job search: /hcm/Jobs/form/JobPosting%5BJobPostingSet%5D.JobSearch?csk.JobBoard=EXTERNAL&csk.HROrganization=1000
//   Job detail: /hcm/Jobs/form/JobPosting%5BJobPostingSet%5D%28{org},{jobId},1%29.JobPostingDisplay?...
//
// Confirmed tenants (2026-06-08):
//   Lee Health: leememorial (Epic Cadence job confirmed)
//   Catholic Health (NY): chsli
//   Lifespan: lifespan
//   Luminis Health: luminis
//   Nuvance Health: nuvance
//   WellSpan Health: wellspan
//   Cone Health: conehealth
//   Samaritan Health Services: samaritan
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchInforHcm(company) {
  if (!company.url) return [];
  try {
    const res = await fetch(company.url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    if (!res.ok) return [];
    const html = await res.text();

    // Infor CloudSuite HCM pre-renders job cards in HTML for SEO/crawlers.
    // Extract job IDs, titles, and locations from pre-rendered Angular output.
    //
    // Primary path: parse pre-rendered job cards
    // Each job card has a link with the job ID in the URL params:
    //   /hcm/Jobs/form/JobPosting[JobPostingSet](1000,{jobId},1).JobPostingDisplay
    const jobLinks = [...html.matchAll(/JobPosting%5BJobPostingSet%5D%28\d+,(\d+),\d+%29\.JobPostingDisplay/g)];
    const seenIds = new Set();
    const jobs = [];

    const baseUrl = new URL(company.url).origin;

    for (const [fullMatch, jobId] of jobLinks) {
      if (seenIds.has(jobId)) continue;
      seenIds.add(jobId);

      // Find title near this link — look for the job title text
      const linkIdx = html.indexOf(fullMatch);
      const ctx = html.slice(Math.max(0, linkIdx - 500), linkIdx + 500);
      const titleMatch = ctx.match(/class="[^"]*(?:job-title|title|heading)[^"]*"[^>]*>([^<]{5,120})</) ||
                         ctx.match(/lm-JobPostingDisplay-toolbar-title[^>]*>([^<]{5,120})</) ||
                         ctx.match(/>([A-Z][^<]{10,100}(?:Analyst|Coordinator|Specialist|Manager|Developer|Engineer|Consultant))<\//);

      const title = titleMatch ? titleMatch[1].trim() : '';
      if (!title) continue;

      // Skip non-Epic roles early
      const haystack = title.toLowerCase() + ' ' + ctx.toLowerCase();
      const epicSignal = ['epic', 'ehr', 'electronic health', 'cadence', 'ambulatory',
                          'inpatient', 'cogito', 'radiant', 'willow', 'optime', 'beacon',
                          'him analyst', 'health informatics', 'clinical informatics',
                          'application analyst', 'systems analyst'].some(k => haystack.includes(k));
      if (!epicSignal) continue;

      // Extract location from nearby context
      const locMatch = ctx.match(/(?:Remote|Fort Myers|Florida|FL|NY|PA|NC|RI|CT|MD|OR)[^<]{0,60}/) ||
                       ctx.match(/([A-Z]{2}).*?(?:Remote|Full Time|Part Time)/);
      const location = locMatch ? locMatch[0].trim().slice(0, 60) : '';

      // Build job detail URL
      const detailUrl = `${baseUrl}/hcm/Jobs/form/JobPosting%5BJobPostingSet%5D%281000,${jobId},1%29.JobPostingDisplay?navigation=JobPosting%5BJobPostingSet%5D%281000,${jobId},1%29.JobPostingDisplayNav&csk.JobBoard=EXTERNAL&csk.HROrganization=1000`;

      jobs.push(makeJob({
        id:          `infor_${company.token}_${jobId}`,
        title,
        company:     company.name,
        location,
        environment: location.toLowerCase().includes('remote') ? 'remote'
                   : location.toLowerCase().includes('hybrid') ? 'hybrid' : '',
        salary:      null, // hourly salary extracted by enrichDescriptions
        url:         detailUrl,
        postedAt:    null,
        atsSource:   'infor_hcm',
        description: '', // enrichDescriptions fetches via job detail page
      }));
    }

    return jobs;
  } catch { return []; }
}

// SELECTMINDS (Oracle Taleo Social Sourcing)
// Confirmed 2026-06-08 via html_probe (aa083s01.upgrade.selectminds.com/utmb):
//
// Architecture: Ember SPA with full server-side rendering of job DETAIL pages.
//   Listing pages: Ember renders job cards client-side — no job hrefs in SSR HTML.
//   Detail pages:  fully SSR'd with title, location, description, hidden inputs.
//
// Discovery strategy: sequential ID walk.
//   Job IDs are sequential integers (current range ~3000–3300).
//   GET /jobs/{id} → 200 = active job (parse it), 404 = expired/invalid (skip).
//   Fetch up to SELECTMINDS_SCAN_WINDOW IDs per alarm cycle, sliding forward from
//   the last confirmed live ID stored in the company's cursor state.
//
// Detail page hidden inputs (confirmed 2026-06-08):
//   Job.id                → SelectMinds integer job ID
//   Job.taleo_job_number  → Taleo requisition ID (UTMB uses Taleo as backend)
//   Job.apply_url         → direct apply URL (may be empty — use detail page URL)
//
// URL patterns confirmed:
//   GET /jobs/{id}                          → detail page (numeric-only redirect)
//   GET /jobs/{title-slug}-{id}             → canonical detail URL
//   GET /jobs/{id}/other-jobs-matching/...  → SSR listing (all jobs, no links)
//   GET /ajax/jobs/{sessionId}/add/category/{catId} → JSON filter API
//     Returns: { "Status":"OK", "UserMessage":"{count}", "Result":"{newSessionId}" }
//
// Known category IDs (UTMB, confirmed by probe 2026-06-08):
//   4  = Faculty (120)
//   5  = Nursing & Care Management (110)
//   19 = Research Academic & Clinical (93)
//   67 = Allied Health
//   8  = Clinical Laboratory (18)
//   6  = Business, Managerial & Finance (39)
//   IT = unknown ID (not in top-6; ~33 jobs based on S9 "33 Epic jobs" observation)
//
// No authentication required. Plain fetch() from CF Worker IP confirmed working.
// Previous S9 "host not in allowlist" error: wrong URL path (/utmb/jobs vs /utmb).
// ─────────────────────────────────────────────────────────────────────────────

const SELECTMINDS_SCAN_WINDOW = 60;  // IDs to scan per alarm cycle
const SELECTMINDS_MIN_ID      = 2000; // Safety floor — IDs below this are too old

export async function fetchSelectMinds(company) {
  if (!company.url) return [];
  try {
    // company.url = 'https://aa083s01.upgrade.selectminds.com/utmb'
    // company.token = numeric string of last confirmed high-water mark ID
    const base     = company.url.replace(/\/$/, '');
    const startId  = Math.max(
      parseInt(company.token ?? '3000', 10) - 10, // scan back 10 from cursor
      SELECTMINDS_MIN_ID
    );
    const endId    = startId + SELECTMINDS_SCAN_WINDOW;

    const jobs = [];

    for (let id = startId; id <= endId; id++) {
      try {
        const res = await fetch(`${base.replace(/\/utmb$/, '')}/jobs/${id}`, {
          headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
          redirect: 'follow',
        });
        if (res.status === 404) continue;
        if (!res.ok) continue;

        const html = await res.text();

        // Confirm this is a real job detail page (not an error or listing page)
        if (!html.includes('name="Job.id"') && !html.includes('job_details.shtml')) continue;

        // Extract Job.id from hidden input (canonical ID, may differ from URL id if redirect)
        const jobIdMatch  = html.match(/name="Job\.id"\s+value="(\d+)"/);
        const taleoMatch  = html.match(/name="Job\.taleo_job_number"\s+value="(\d+)"/);
        const applyMatch  = html.match(/name="Job\.apply_url"\s+value="([^"]*)"/);
        const jobId       = jobIdMatch?.[1] ?? String(id);
        const taleoNum    = taleoMatch?.[1] ?? '';

        // Title: <title> tag, strip " - UTMB Health..." suffix
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const rawTitle   = titleMatch?.[1]?.trim() ?? '';
        const title      = rawTitle
          .replace(/\s*-\s*UTMB Health Talent Acquisition Team Careers.*$/i, '')
          .trim();
        if (!title) continue;

        // og:title contains "Title in City, State" — extract location from it
        const ogTitle    = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] ?? '';
        const location   = ogTitle.includes(' in ')
          ? ogTitle.replace(/^.*? in /, '').replace(/,\s*United States$/, '').trim()
          : '';

        // Description: og:description (snippet only) — enrich.js fetches full body
        const description = html.match(
          /<meta[^>]+name="description"[^>]+content="([^"]+)"/i
        )?.[1]?.trim() ?? '';

        // Canonical URL: prefer /jobs/{slug}-{id} form from <link rel="canonical">
        const canonMatch = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i);
        const applyUrl   = applyMatch?.[1] || canonMatch?.[1]
          || `${base.replace(/\/utmb$/, '')}/jobs/${jobId}`;

        const environment = location.toLowerCase().includes('remote') ? 'remote'
                          : location.toLowerCase().includes('hybrid') ? 'hybrid' : '';

        jobs.push(makeJob({
          id:          `selectminds_${jobId}`,
          title,
          company:     company.name,
          location,
          environment,
          salary:      null,                  // SelectMinds/Taleo does not disclose salary
          url:         applyUrl,
          postedAt:    null,                  // Not in page HTML
          atsSource:   'selectminds',
          description,                        // og:description snippet; enrich.js gets body
          // Store Taleo number for potential cross-reference
          ...(taleoNum ? { _taleoNum: taleoNum } : {}),
        }));

        await new Promise(r => setTimeout(r, 150)); // polite delay
      } catch { continue; }
    }

    if (jobs.length > 0) {
      console.log(`[STAT SelectMinds] ${company.name}: ${jobs.length} jobs from ID range ${startId}-${endId}`);
    }
    return jobs;

  } catch { return []; }
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
    case 'oracle_hcm':     return fetchOracleHcm(company);
    case 'infor_hcm':      return fetchInforHcm(company);
    case 'selectminds':    return fetchSelectMinds(company);
    default: return [];
  }
}
// browser rendering + SF fix deployed
