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
// Public XML feed — no auth required
// URL pattern: career4.successfactors.com/career?company={id}&career_ns=job_listing_summary&resultType=XML
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchSuccessFactors(company) {
  if (!company.url) return [];
  try {
    const res = await fetch(company.url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return [];
    const xml = await res.text();
    // Parse job items from XML — SAP SF uses <item> or <job> elements
    const itemMatches = [...xml.matchAll(/<(item|job)>([\s\S]*?)<\/(item|job)>/g)];
    return itemMatches.map(m => {
      const block = m[2];
      const title    = (block.match(/<title[^>]*>(.*?)<\/title>/)    ?? [])[1] ?? '';
      const id       = (block.match(/<jobId[^>]*>(.*?)<\/jobId>/)    ?? [])[1]
                    ?? (block.match(/<guid[^>]*>(.*?)<\/guid>/)       ?? [])[1]
                    ?? String(Math.random());
      const location = (block.match(/<location[^>]*>(.*?)<\/location>/) ?? [])[1] ?? '';
      const url      = (block.match(/<link[^>]*>(.*?)<\/link>/)      ?? [])[1]
                    ?? (block.match(/<url[^>]*>(.*?)<\/url>/)         ?? [])[1] ?? '';
      const pubDate  = (block.match(/<pubDate[^>]*>(.*?)<\/pubDate>/)  ?? [])[1] ?? null;
      return makeJob({
        id, title: title.replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
        company:   company.name,
        location:  location.replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
        environment: normalizeEnv(location),
        salary:    null,
        url:       url.replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
        postedAt:  pubDate,
        atsSource: 'successfactors',
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
// SSR __NEXT_DATA__ payload scrape (wide-net fallback)
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
    return jobs.map(j => makeJob({
      id:          String(j.id ?? j.jobId ?? j.uid ?? JSON.stringify(j).slice(0, 32)),
      title:       j.title ?? j.jobTitle ?? '',
      company:     j.company?.name ?? j.companyName ?? '',
      location:    j.location?.display ?? j.locationDisplay ?? j.location ?? '',
      environment: j.workplaceType ?? j.workplace_type ?? j.environment ?? '',
      salary:      normalizeSalary(j.salary?.min ?? j.salaryMin, j.salary?.max ?? j.salaryMax),
      url:         j.applicationUrl ?? j.applyUrl ?? `https://hiring.cafe/job/${j.id}`,
      postedAt:    j.postedAt ?? j.posted_at ?? j.createdAt ?? null,
      atsSource:  'hiringcafe',
    }));
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
