/**
 * STAT — Second-Pass Description Enrichment
 *
 * ATS platforms that don't return description in their list/search API:
 *   Workday, iCIMS, SuccessFactors, Taleo
 *
 * For new keyword-matched jobs from these platforms, fetch the job page
 * and extract description text from the OpenGraph meta tag.
 *
 * How we know this works:
 *   Probe of msmc.wd12.myworkdayjobs.com confirmed the og:description
 *   meta tag contains the full job description as plain text on every
 *   Workday job page — no JS execution required, no auth required.
 *   One plain HTML GET per new match.
 *
 * Cost:
 *   Only fires for genuinely new keyword-matched jobs (not seen before).
 *   At typical match rates (5-20 new jobs/day), this is 5-20 additional
 *   HTTP requests/day — negligible against the CPU budget.
 *   Timeout: 5s — drops gracefully if page is slow, job still alerts.
 *
 * ATS platforms that DON'T need this (description already in list API):
 *   Greenhouse (?content=true returns j.content)
 *   Lever      (j.description.content)
 *   Ashby      (j.jobDescription.descriptionHtml)
 *   HiringCafe (job_information.description from v5 payload)
 */

// ATS platforms that need second-pass description fetch
const NEEDS_DESCRIPTION_FETCH = new Set([
  'workday',
  'icims',
  'successfactors',
  'taleo',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Fetch og:description from a job page
// Returns description string or '' on any failure
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchJobDescription(job) {
  // Skip if already have description
  if (job.description) return job.description;

  // Skip if this ATS provides description in list API
  if (!NEEDS_DESCRIPTION_FETCH.has(job.atsSource)) return '';

  // Skip if no URL
  if (!job.url) return '';

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 5_000);

  try {
    const res = await fetch(job.url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':     'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!res.ok) return '';

    const html = await res.text();

    // Strategy 1: OpenGraph description (confirmed working on Workday)
    // This is the most reliable — Workday renders full description here
    const ogMatch = html.match(
      /<meta\s+(?:name|property)="(?:og:description|description)"[^>]*content="([^"]{20,})"[^>]*>/i
    ) || html.match(
      /<meta\s+content="([^"]{20,})"[^>]*(?:name|property)="(?:og:description|description)"[^>]*>/i
    );
    if (ogMatch) {
      return decodeHtmlEntities(ogMatch[1]);
    }

    // Strategy 2: JSON-LD structured data (some ATS use schema.org JobPosting)
    const ldMatch = html.match(
      /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i
    );
    if (ldMatch) {
      try {
        const ld = JSON.parse(ldMatch[1]);
        const desc = ld.description || ld.jobDescription;
        if (desc && desc.length > 20) return stripHtml(desc);
      } catch {}
    }

    // Strategy 3: iCIMS — description in meta description tag
    const metaMatch = html.match(
      /<meta\s+name="description"[^>]*content="([^"]{20,})"[^>]*>/i
    );
    if (metaMatch) {
      return decodeHtmlEntities(metaMatch[1]);
    }

    return '';

  } catch (e) {
    clearTimeout(timeout);
    // Timeout or network error — non-blocking, job still alerts
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Enrich a batch of new matches with descriptions
// Runs second-pass fetches concurrently (capped at 3 parallel to be polite)
// Sets job.description in-place on each job that needs it
// Non-blocking: failures leave job.description = '' — alert still fires
// ─────────────────────────────────────────────────────────────────────────────
export async function enrichDescriptions(matches) {
  const needsFetch = matches.filter(({ job }) =>
    !job.description && NEEDS_DESCRIPTION_FETCH.has(job.atsSource) && job.url
  );

  if (needsFetch.length === 0) return;

  // Process in batches of 3 — polite, avoids thundering herd on ATS servers
  const CONCURRENCY = 3;
  for (let i = 0; i < needsFetch.length; i += CONCURRENCY) {
    const batch = needsFetch.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ job }) => {
      const desc = await fetchJobDescription(job);
      if (desc) {
        job.description = desc;
        console.log(`[STAT enrich] Got description for ${job.title} @ ${job.company} (${job.atsSource}, ${desc.length} chars)`);
      }
    }));
    // Small delay between batches
    if (i + CONCURRENCY < needsFetch.length) {
      await new Promise(r => setTimeout(r, 200));
    }
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
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
