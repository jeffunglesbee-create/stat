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
export async function fetchWorkday(company) {
  if (!company.url) return [];

  // Attempt 1: Workday's internal search API (JSON, much cleaner than SSR)
  // Pattern: replace /en-US/... with /wday/cxs/.../jobs
  try {
    const parsed = new URL(company.url);
    const tenant = parsed.hostname.split('.')[0]; // e.g. "jhhs"
    const apiUrl = `${parsed.origin}/wday/cxs/${tenant}/External_Career_Site/jobs`;
    const body = JSON.stringify({
      appliedFacets: {},
      limit: 20,
      offset: 0,
      searchText: '',
    });
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': UA,
      },
      body,
    });
    if (res.ok) {
      const data = await res.json();
      const jobs = data.jobPostings ?? [];
      if (jobs.length > 0) {
        return jobs.map(j => makeJob({
          id:          j.bulletFields?.[0] ?? j.title ?? Math.random().toString(36),
          title:       j.title ?? '',
          company:     company.name,
          location:    j.locationsText ?? j.bulletFields?.[1] ?? '',
          environment: (() => {
            const loc = (j.locationsText ?? '').toLowerCase();
            if (loc.includes('remote')) return 'remote';
            if (loc.includes('hybrid')) return 'hybrid';
            return '';
          })(),
          salary:      null, // Workday rarely exposes salary in the listing JSON
          url:         j.externalPath ? `${parsed.origin}${j.externalPath}` : company.url,
          postedAt:    j.postedOn ?? null,
          atsSource:   'workday',
        }));
      }
    }
  } catch { /* fall through to SSR */ }

  // Attempt 2: SSR __NEXT_DATA__ or Workday inline JSON
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
      return jobs.map(j => makeJob({
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
    }

    // Try inline JSON blob (Workday embeds job data as a JS variable)
    const inlineMatch = html.match(/window\.__reactiveStore\s*=\s*({[\s\S]*?});\s*<\/script>/);
    if (inlineMatch) {
      const data = JSON.parse(inlineMatch[1]);
      const jobs = data?.jobPostings ?? data?.jobs ?? [];
      return jobs.map(j => makeJob({
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
  if (!company.url) return [];

  // Derive base from the search URL
  const base = company.url.replace(/\/jobs\/search.*$/, '');

  // Attempt 1: sitemap.xml — all jobs + lastmod in one request
  try {
    const sitemapUrl = `${base}/sitemap.xml`;
    const res = await fetch(sitemapUrl, { headers: { 'User-Agent': UA } });
    if (res.ok) {
      const xml = await res.text();
      // Extract <url> blocks containing /jobs/ paths
      const urlBlocks = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)];
      const jobs = [];
      for (const block of urlBlocks) {
        const locMatch = block[1].match(/<loc>(.*?)<\/loc>/);
        const lastmodMatch = block[1].match(/<lastmod>(.*?)<\/lastmod>/);
        if (!locMatch) continue;
        const loc = locMatch[1];
        if (!loc.includes('/jobs/')) continue;
        const lastmod = lastmodMatch?.[1] ?? null;
        // Extract job ID from URL: /jobs/12345/job-title
        const idMatch = loc.match(/\/jobs\/(\d+)\//);
        const id = idMatch?.[1] ?? loc;
        jobs.push(makeJob({
          id,
          title:      '', // fetch individual job for title would be too many requests
          company:    company.name,
          location:   '',
          environment: '',
          salary:     null,
          url:        loc,
          postedAt:   lastmod,
          atsSource:  'icims',
        }));
      }
      if (jobs.length > 0) return jobs;
    }
  } catch { /* fall through */ }

  // Attempt 2: HTML job search page
  try {
    const searchUrl = `${base}/jobs/search?in_iframe=1`;
    const res = await fetch(searchUrl, { headers: { 'User-Agent': UA } });
    if (!res.ok) return [];
    const html = await res.text();
    // iCIMS embeds job data in iCIMS_Job elements
    const jobMatches = [...html.matchAll(/class="iCIMS_JobTitle"[^>]*>([^<]*)<[\s\S]*?href="([^"]+\/jobs\/(\d+)\/[^"]+)"/g)];
    return jobMatches.map(m => makeJob({
      id:          m[3],
      title:       m[1].trim(),
      company:     company.name,
      location:    '',
      environment: '',
      salary:      null,
      url:         m[2],
      postedAt:    null,
      atsSource:   'icims',
    }));
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
      const description = cdata('Job-Description');
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
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchTaleo(company) {
  if (!company.url) return [];
  try {
    const res = await fetch(company.url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return [];
    const html = await res.text();

    // Taleo embeds job data as JavaScript: var jobData = {...}
    const jsonMatch = html.match(/var\s+(?:jobData|jobs)\s*=\s*(\[[\s\S]*?\]);/);
    if (jsonMatch) {
      const jobs = JSON.parse(jsonMatch[1]);
      return jobs.map(j => makeJob({
        id:         j.requisitionId ?? j.id ?? String(Math.random()),
        title:      j.title ?? j.jobTitle ?? '',
        company:    company.name,
        location:   j.location ?? j.city ?? '',
        environment: '',
        salary:     null,
        url:        j.detailUrl ?? j.url ?? company.url,
        postedAt:   j.postedDate ?? j.openDate ?? null,
        atsSource:  'taleo',
      }));
    }

    // Fallback: parse HTML table rows (Taleo classic layout)
    const rowMatches = [...html.matchAll(/class="resultLink"[^>]*href="([^"]+)"[^>]*>([^<]+)<[\s\S]*?class="jobDate"[^>]*>([^<]+)</g)];
    return rowMatches.map(m => makeJob({
      id:         m[1].match(/jobId=(\d+)/)?.[1] ?? m[1],
      title:      m[2].trim(),
      company:    company.name,
      location:   '',
      environment: '',
      salary:     null,
      url:        m[1].startsWith('http') ? m[1] : `${new URL(company.url).origin}${m[1]}`,
      postedAt:   m[3].trim() || null,
      atsSource:  'taleo',
    }));
  } catch { return []; }
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
export async function fetchHiringCafe(keyword, environment) {
  const params = new URLSearchParams({ q: keyword, environment });
  const url = `https://hiring.cafe/?${params}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return [];
    const data = JSON.parse(match[1]);
    const pp = data?.props?.pageProps ?? {};
    const jobs = pp.jobs ?? pp.jobListings ?? pp.results ?? pp.data?.jobs ?? [];
    if (!Array.isArray(jobs)) return [];

    return jobs.map(j => {
      // v5_processed_job_data is HiringCafe's AI enrichment layer — the gold mine
      const v5  = j.v5_processed_job_data ?? {};
      const inf = j.job_information ?? {};

      // Structured salary from v5 (yearly preferred, falls back to other frequencies)
      const salMin = v5.yearly_min_compensation ?? v5.monthly_min_compensation * 12
                     ?? v5.hourly_min_compensation * 2080 ?? j.salaryMin ?? null;
      const salMax = v5.yearly_max_compensation ?? v5.monthly_max_compensation * 12
                     ?? v5.hourly_max_compensation * 2080 ?? j.salaryMax ?? null;

      // State eligibility — the most valuable field for Maryland scoring
      // workplace_states = states where the role is located/approved
      // boundless_workplace_states = states explicitly approved for remote work
      // Empty boundless + workplace_type=Remote = likely nationwide
      const workplaceStates     = v5.workplace_states     ?? [];   // e.g. ["Maryland, US", "Virginia, US"]
      const boundlessStates     = v5.boundless_workplace_states ?? [];
      const isWorldwide         = v5.is_workplace_worldwide_ok ?? false;
      const workplaceType       = v5.workplace_type ?? j.workplaceType ?? j.workplace_type ?? '';

      // Derive environment from v5 (more reliable than raw field)
      const envRaw = workplaceType || v5.workplace_physical_environment || '';

      // ATS source info — enables auto-promotion to direct DO watching
      const atsSource   = j.source ?? 'hiringcafe';
      const boardToken  = j.board_token ?? j.board_token ?? '';
      const applyUrl    = j.apply_url ?? j.applicationUrl ?? j.applyUrl
                          ?? `https://hiring.cafe/job/${j.requisition_id ?? j.id}`;

      // Full description from job_information (same HTML as job detail page)
      const description = inf.description ?? inf.descriptionHtml ?? '';

      // Location: prefer formatted string from v5
      const location = v5.formatted_workplace_location
                       ?? j.location?.display ?? j.locationDisplay ?? j.location ?? '';

      const job = makeJob({
        id:          String(j.id ?? j.requisition_id ?? j.objectID
                            ?? JSON.stringify(j).slice(0, 32)),
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

      // Attach HiringCafe-specific enrichment fields to the job object
      // These are used by the Maryland scorer and future enrichment layers
      job.hc = {
        workplaceStates,          // ["Maryland, US"] — structured state list
        boundlessStates,          // explicitly approved remote states
        isWorldwide,              // true = no state restriction
        workplaceType,            // 'Remote' | 'Hybrid' | 'Onsite'
        requirementsSummary: v5.requirements_summary ?? '',
        seniorityLevel:     v5.seniority_level ?? '',
        salaryTransparent:  v5.is_compensation_transparent ?? false,
        visaSponsorship:    v5.visa_sponsorship ?? false,
        minYoe:             v5.min_industry_and_role_yoe ?? null,
        certifications:     v5.licenses_or_certifications ?? [],
        technicalTools:     v5.technical_tools ?? [],
        atsSource,            // original ATS (greenhouse/workday/etc.)
        boardToken,           // ATS board slug for DO auto-promotion
        companySize:        j.enriched_company_data?.nb_employees ?? null,
        companyFounded:     j.enriched_company_data?.year_founded ?? null,
        companyIndustries:  j.enriched_company_data?.industries ?? [],
      };

      return job;
    });
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher — routes to the right adapter by ATS type
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchCompanyJobs(company) {
  switch (company.ats) {
    case 'greenhouse':     return fetchGreenhouse(company);
    case 'lever':          return fetchLever(company);
    case 'ashby':          return fetchAshby(company);
    case 'workday':        return fetchWorkday(company);
    case 'icims':          return fetchICIMS(company);
    case 'successfactors': return fetchSuccessFactors(company);
    case 'taleo':          return fetchTaleo(company);
    default: return [];
  }
}
// browser rendering + SF fix deployed
