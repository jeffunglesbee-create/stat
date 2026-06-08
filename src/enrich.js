/**
 * STAT — Second-Pass Description Enrichment
 *
 * ATS platforms and their description strategies:
 *
 *   Greenhouse    → description in list API response (j.content, ?content=true)
 *   Lever         → description in list API response (j.description.content)
 *   Ashby         → description in list API response (j.jobDescription.descriptionHtml)
 *   HiringCafe    → description in v5 payload (job_information.description)
 *   Workday       → JSON-LD schema.org/JobPosting (full desc, ~4k chars) → data-automation-id="jobPostingDescription" DOM → og:description fallback (boilerplate only)
 *   Oracle HCM    → class="job-details__description-content" div → og:description fallback
 *   Infor HCM     → class="lm-richtext-content _op_PositionDescription..." div → full body text fallback
 *   iCIMS         → page is a SPA — Browser Rendering API required
 *   Taleo         → initialHistory hidden field (URL-decoded, !|! delimited) → plain fetch
 *   SuccessFactors → page is a SPA — no path without auth; use HiringCafe v5 coverage
 *
 * Browser Rendering API:
 *   Cloudflare runs headless Chromium at the edge. Workers Paid includes
 *   10 browser-hours/month free (~7,200 fetches at 5s each). Cost beyond
 *   that: $0.09/additional browser hour.
 *
 *   Binding: env.MYBROWSER (declared in wrangler.toml as [browser] binding)
 *   Package: @cloudflare/puppeteer (Cloudflare's fork — NOT standard puppeteer)
 *   Session reuse: puppeteer.sessions() → puppeteer.connect() to avoid launching
 *     a new browser instance for every fetch. Reduces billing and latency.
 *
 * All fetches are non-blocking — failures return '' and the job still alerts.
 */

import puppeteer from '@cloudflare/puppeteer';

// ATS platforms needing plain HTML og:description fetch
// iCIMS verified 2026-06-06: plain fetch() with ?in_iframe=1 works from CF Worker.
// Moved from NEEDS_BROWSER_FETCH. See session doc Part 2 for full investigation.
const NEEDS_PLAIN_FETCH = new Set(['workday', 'icims', 'hiringcafe', 'oracle_hcm', 'infor_hcm', 'taleo']);

// ATS platforms needing JavaScript execution via Browser Rendering.
// Taleo only — iCIMS moved to NEEDS_PLAIN_FETCH (plain fetch + ?in_iframe=1).
// NEEDS_BROWSER_FETCH removed 2026-06-08 — all ATS description paths now use plain fetch.
// Taleo search page still uses BR (adapters.js fetchTaleo) but detail pages do not.

// ─────────────────────────────────────────────────────────────────────────────
// Plain HTML fetch — server-rendered description (Workday + iCIMS)
//
// Workday: og:description in server-rendered HTML. ~200ms.
// iCIMS:   job detail at /jobs/{id}/job?in_iframe=1 returns server-rendered HTML.
//          The ?in_iframe=1 param bypasses the branded wrapper redirect.
//          Description is in body text (no og:description on iCIMS detail pages).
//          Verified 2026-06-06: plain fetch() from CF Worker is not blocked.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchPlainDescription(job) {
  if (!job.url) return '';

  // For HiringCafe: build URL from hc.requisitionId — job.url is the ATS apply URL
  // The description lives on hiring.cafe/job/{requisitionId}, not on the apply URL.
  // Verified 2026-06-07: plain fetch returns __NEXT_DATA__ with full description.
  let fetchUrl = job.url;
  if (job.atsSource === 'hiringcafe') {
    const rid = job.hc?.requisitionId;
    if (!rid) return '';
    fetchUrl = `https://hiring.cafe/job/${rid}`;
  }
  // For iCIMS: strip query params and append ?in_iframe=1
  // Confirmed 2026-06-08 via CommonSpirit HTML: the branded wrapper loads the
  // actual job content in #icims_content_iframe at the same URL + &in_iframe=1.
  // The full path (including slug) must be preserved.
  //
  // BUG FIXED: prior regex .replace(/\/jobs\/(\d+)\/[^?]+/, '/jobs/$1/job')
  // was dropping the slug and the /job path segment, producing:
  //   /jobs/468417/job?in_iframe=1  (wrong — 404 on most tenants)
  // instead of:
  //   /jobs/468417/it-epic-ambulatory-application-analyst-sr/job?in_iframe=1
  //
  // Fix: simply strip query params, keep full path, append ?in_iframe=1.
  if (job.atsSource === 'icims') {
    fetchUrl = fetchUrl.split('?')[0] + '?in_iframe=1';
  }

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 8_000);

  try {
    const res = await fetch(fetchUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control':   'no-cache',
      },
      redirect: 'follow',
    });
    clearTimeout(timeout);
    if (!res.ok) return '';

    const html = await res.text();

    // iCIMS: extract from body text — no og:description on detail pages
    if (job.atsSource === 'icims') {
      // Strip scripts/styles, extract visible text
      const bodyText = html
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Skip navigation header — content starts after "Welcome page" or job title
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const jobTitle   = titleMatch ? titleMatch[1].split('|')[0].trim() : '';
      const titleIdx   = jobTitle ? bodyText.indexOf(jobTitle) : -1;
      const contentStart = titleIdx > 0 ? titleIdx + jobTitle.length : 0;
      const content    = bodyText.slice(contentStart, contentStart + 4000).trim();

      return content.length > 50 ? content : bodyText.slice(0, 3000);
    }

    // HiringCafe: description lives in __NEXT_DATA__.props.pageProps.job.job_information.description
    // The job detail page (hiring.cafe/job/{requisitionId}) is fully server-rendered.
    // Verified 2026-06-07: pp.job.job_information.description contains full HTML description.
    // Note: fetchUrl is overridden to the HC job page URL (not the apply_url).
    if (job.atsSource === 'hiringcafe') {
      try {
        const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (nd) {
          const data = JSON.parse(nd[1]);
          const pp = data?.props?.pageProps ?? {};
          const jobObj = pp.job ?? {};
          const inf = jobObj.job_information ?? {};
          const desc = inf.description ?? inf.descriptionHtml ?? '';
          if (desc && desc.length > 20) {
            return desc
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
              .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
              .replace(/\s+/g, ' ').trim();
          }
        }
      } catch {}
      // Fallback: og:description (truncated but available)
      const ogFb = html.match(/<meta[^>]+(?:name|property)="og:description"[^>]+content="([^"]{20,})"/i)
                || html.match(/<meta[^>]+content="([^"]{20,})"[^>]+(?:name|property)="og:description"/i);
      if (ogFb) return decodeHtmlEntities(ogFb[1]);
      return '';
    }

    // Workday: three paths in priority order (confirmed 2026-06-08 via MSMC HTML analysis)
    //
    // PATH 1 — JSON-LD schema.org/JobPosting (BEST)
    //   Full description as JSON string — no HTML parsing, clean text.
    //   Confirmed present on Workday job detail pages (MSMC: 4,000+ chars).
    //   Only available on job DETAIL pages (not listing pages).
    //
    // PATH 2 — data-automation-id="jobPostingDescription" DOM element
    //   Full description pre-rendered in SSR HTML shell by Workday for SEO.
    //   Ember SPA renders into this element client-side, but it's also in
    //   the server-rendered HTML. 6,694 chars confirmed on MSMC page.
    //
    // PATH 3 — og:description (LAST RESORT)
    //   Confirmed to be company boilerplate only (668 chars on MSMC).
    //   NOT the job description. Only use if both above fail.

    // PATH 1: JSON-LD
    const ld = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (ld) {
      try {
        const d = JSON.parse(ld[1]);
        const desc = d.description || d.jobDescription;
        if (desc && desc.length > 100) return stripHtml(desc);
      } catch {}
    }

    // PATH 2: data-automation-id="jobPostingDescription" pre-rendered DOM
    const domDesc = html.match(/data-automation-id="jobPostingDescription"[^>]*>([\s\S]+?)(?=data-automation-id="similar-jobs|data-automation-id="jobSidebar|<\/section|<\/main)/i);
    if (domDesc) {
      const stripped = stripHtml(domDesc[1]);
      if (stripped.length > 100) return stripped;
    }

    // PATH 3: og:description — boilerplate fallback only
    const og = html.match(
      /<meta\s+(?:name|property)="(?:og:description|description)"[^>]*content="([^"]{20,})"[^>]*>/i
    ) || html.match(
      /<meta\s+content="([^"]{20,})"[^>]*(?:name|property)="(?:og:description|description)"[^>]*>/i
    );
    if (og) return decodeHtmlEntities(og[1]);

    // Oracle HCM (Fusion Cloud): description pre-rendered for SEO in Oracle JET HTML.
    // Confirmed 2026-06-08 via Cedars-Sinai: class="job-details__description-content" div
    // contains full JD. No JSON-LD, no og:description with actual content.
    // Salary also pre-rendered: "Minimum Salary {n}" / "Maximum Salary {n}" in body text.
    if (job.atsSource === 'oracle_hcm') {
      // PATH 1: job-details__description-content div (confirmed Cedars-Sinai)
      const oracleDesc = html.match(/class="[^"]*job-details__description-content[^"]*"[^>]*>([\s\S]{100,15000}?)<\/div>\s*<\/div>/i);
      if (oracleDesc) {
        const stripped = stripHtml(oracleDesc[1]);
        if (stripped.length > 100) return stripped;
      }
      // PATH 2: full body text extraction starting from description region
      // Oracle pre-renders full page including Qualifications and Job Info
      const bodyText = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ').trim();
      // Find start of actual job content (skip header nav)
      const jobStart = bodyText.search(/(?:What will you be doing|Job Description|Overview|Position Summary|Responsibilities)/i);
      if (jobStart > 0) {
        const endMarkers = ['Sign In', 'Apply Now', 'Similar Jobs', 'Related Jobs', 'Job Info'];
        let jobEnd = bodyText.length;
        for (const m of endMarkers) {
          const idx = bodyText.indexOf(m, jobStart + 100);
          if (idx > jobStart) jobEnd = Math.min(jobEnd, idx);
        }
        const extracted = bodyText.slice(jobStart, jobEnd).trim();
        if (extracted.length > 100) return extracted;
      }
      // PATH 3: og:description fallback (limited but better than nothing)
      const ogFb = html.match(/<meta[^>]+(?:name|property)="og:description"[^>]+content="([^"]{20,})"/i)
                || html.match(/<meta[^>]+content="([^"]{20,})"[^>]+(?:name|property)="og:description"/i);
      if (ogFb) return decodeHtmlEntities(ogFb[1]);
      return '';
    }

    // Infor CloudSuite HCM: Angular SPA, description pre-rendered in Angular Landmark component.
    // Confirmed 2026-06-08 via Lee Health: class="lm-richtext-content _op_PositionDescription..."
    // Salary is hourly ("$N.NN - $N.NN / hour") — converted to annual (× 2080).
    // No JSON-LD, no og:description, no meta tags.
    if (job.atsSource === 'infor_hcm') {
      // PATH 1: lm-richtext-content div with _op_PositionDescription class
      const inforDesc = html.match(/class="[^"]*lm-richtext-content[^"]*_op_PositionDescription[^"]*"[^>]*>([\s\S]{100,15000}?)(?:<div[^>]*_ngcontent|<\/div>\s*<\/div>\s*<\/div>)/i);
      if (inforDesc) {
        const stripped = stripHtml(inforDesc[1]);
        if (stripped.length > 100) {
          // Extract hourly salary and inject annual equivalent
          const hourlyMatch = stripped.match(/\$(\d+\.\d+)\s*[-–]\s*\$(\d+\.\d+)\s*\/\s*hour/i);
          if (hourlyMatch && !job.salary) {
            const lo = Math.round(parseFloat(hourlyMatch[1]) * 2080);
            const hi = Math.round(parseFloat(hourlyMatch[2]) * 2080);
            job.salary = `$${Math.round(lo/1000)}k–$${Math.round(hi/1000)}k`;
            job.salaryRaw = { min: lo, max: hi };
          }
          return stripped;
        }
      }
      // PATH 2: full body text — Angular pre-renders full content for SEO
      const bodyText = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ').trim();
      // Find description content (starts after salary/location header)
      const descStart = bodyText.search(/(?:Summary|Description|Responsibilities|Job Description|About this role)/i);
      if (descStart > 0) {
        const endMarkers = ['Apply', 'Save', 'Sign In', 'Register', 'Loading...', 'Selected Report'];
        let descEnd = bodyText.length;
        for (const m of endMarkers) {
          const idx = bodyText.indexOf(m, descStart + 100);
          if (idx > descStart) descEnd = Math.min(descEnd, idx);
        }
        const extracted = bodyText.slice(descStart, descEnd).trim();
        if (extracted.length > 100) {
          // Extract hourly salary from surrounding context
          const hourlyMatch = bodyText.match(/\$(\d+\.\d+)\s*[-–]\s*\$(\d+\.\d+)\s*\/\s*hour/i);
          if (hourlyMatch && !job.salary) {
            const lo = Math.round(parseFloat(hourlyMatch[1]) * 2080);
            const hi = Math.round(parseFloat(hourlyMatch[2]) * 2080);
            job.salary = `$${Math.round(lo/1000)}k–$${Math.round(hi/1000)}k`;
            job.salaryRaw = { min: lo, max: hi };
          }
          return extracted;
        }
      }
      return '';
    }

    // Taleo (Oracle): description embedded in hidden <input id="initialHistory"> field.
    // Confirmed 2026-06-08 via UPMC jobdetail.ftl HTML analysis:
    //   Field is URL-encoded, 154+ pipe-delimited (!|!) values.
    //   Description sections delimited by !*! within the pipe fields.
    //   Salary: hourly rate in fields [39] (max) and [40] (min) — converted × 2080.
    //   All job data present in plain HTML GET — BR not required for detail pages.
    //
    // Detail page URL: {tenant}.taleo.net/careersection/{n}/jobdetail.ftl?job={id}
    // (NOT jobapply.ftl — that is the application form, wrong page)
    if (job.atsSource === 'taleo') {
      // Extract initialHistory hidden field
      const histMatch = html.match(/id="initialHistory"\s+value="([^"]{200,})"/i)
                     || html.match(/name="initialHistory"\s+[^>]*value="([^"]{200,})"/i);
      if (histMatch) {
        try {
          const decoded = decodeURIComponent(histMatch[1]);
          const fields = decoded.split('!|!');

          // Description: fields containing !*! delimiter are description sections
          const descSections = [];
          for (const field of fields) {
            if (field.includes('!*!')) {
              const sections = field.split('!*!').filter(s => s.trim().length > 20);
              descSections.push(...sections);
            }
          }
          const description = descSections
            .join(' ')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\:/g, ':').replace(/\\:/g, ':')
            .replace(/\s+/g, ' ').trim();

          if (description.length > 100) {
            // Extract hourly salary from fields [39/40/41]
            if (!job.salary && fields.length > 41) {
              const minRaw = parseFloat(fields[40]);
              const maxRaw = parseFloat(fields[39]);
              if (!isNaN(minRaw) && !isNaN(maxRaw) && minRaw > 0 && maxRaw > 0) {
                const lo = Math.round(minRaw * 2080);
                const hi = Math.round(maxRaw * 2080);
                job.salary = `$${Math.round(lo/1000)}k–$${Math.round(hi/1000)}k`;
                job.salaryRaw = { min: lo, max: hi };
              }
            }
            return description;
          }
        } catch {}
      }

      // Fallback: body text starting after "Beginning of the main content"
      const bodyText = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ').trim();
      const mainIdx = bodyText.indexOf('Beginning of the main content');
      if (mainIdx > 0) {
        const extracted = bodyText.slice(mainIdx + 40, mainIdx + 4000).trim();
        if (extracted.length > 100) return extracted;
      }
      return '';
    }

    return '';
  } catch {
    clearTimeout(timeout);
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchJobDescription — routes to correct strategy by ATS
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchJobDescription(job, env) {
  if (job.description) return job.description; // already have it
  if (!job.url)        return '';

  if (NEEDS_PLAIN_FETCH.has(job.atsSource)) {
    return fetchPlainDescription(job);
  }

  if (NEEDS_BROWSER_FETCH.has(job.atsSource)) {
    return fetchBrowserDescription(job, env);
  }

  return ''; // SuccessFactors — description already in XML feed (fetched in adapters.js)
}

// ─────────────────────────────────────────────────────────────────────────────
// enrichDescriptions — batch enrich new matches before MD scoring
//
// Plain fetches: 3 concurrent, 200ms between batches
// Browser fetches: 1 at a time (session reuse reduces overhead but
//   concurrent browser sessions consume concurrency limit faster)
// Both: non-blocking — failure returns '', job still alerts
// ─────────────────────────────────────────────────────────────────────────────
export async function enrichDescriptions(matches, env) {
  const plain   = matches.filter(({ job }) =>
    !job.description && NEEDS_PLAIN_FETCH.has(job.atsSource) && job.url
  );
  const browser = matches.filter(({ job }) =>
    !job.description && NEEDS_BROWSER_FETCH.has(job.atsSource) && job.url
  );

  // Plain fetches — fast, run 3 concurrent
  const CONCURRENCY = 3;
  for (let i = 0; i < plain.length; i += CONCURRENCY) {
    const batch = plain.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ job }) => {
      const desc = await fetchPlainDescription(job);
      if (desc) {
        job.description = desc;
        console.log(`[STAT enrich] Plain ${job.atsSource}: ${job.title} @ ${job.company} (${desc.length} chars)`);
      }
    }));
    if (i + CONCURRENCY < plain.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Browser fetches — sequential to manage session concurrency
  for (const { job } of browser) {
    const desc = await fetchBrowserDescription(job, env);
    if (desc) {
      job.description = desc;
    }
    // Small gap between browser fetches
    await new Promise(r => setTimeout(r, 500));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml(html) {
  return html
    .replace(/\\r\\n/g, ' ')   // literal \r\n escape sequences (SF XML artifact)
    .replace(/\\n/g, ' ')        // literal \n escape sequences
    .replace(/\\r/g, ' ')        // literal \r escape sequences
    .replace(/&#?[a-zA-Z0-9]+;/g, ' ')  // HTML entities
    .replace(/<[^>]+>/g, ' ')     // HTML tags
    .replace(/\s+/g, ' ')
    .trim();
}
