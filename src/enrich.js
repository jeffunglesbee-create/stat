/**
 * STAT — Second-Pass Description Enrichment
 *
 * ATS platforms and their description strategies:
 *
 *   Greenhouse    → description in list API response (j.content, ?content=true)
 *   Lever         → description in list API response (j.description.content)
 *   Ashby         → description in list API response (j.jobDescription.descriptionHtml)
 *   HiringCafe    → description in v5 payload (job_information.description)
 *   Workday       → og:description meta tag on job page (plain HTML GET, ~200ms)
 *   iCIMS         → page is a SPA — Browser Rendering API required
 *   Taleo         → page is a SPA — Browser Rendering API required
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
const NEEDS_PLAIN_FETCH = new Set(['workday']);

// ATS platforms needing JavaScript execution via Browser Rendering
const NEEDS_BROWSER_FETCH = new Set(['icims', 'taleo']);

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

  // For iCIMS: append ?in_iframe=1 to the job detail URL
  // This bypasses the branded wrapper redirect and returns the iCIMS portal HTML.
  let fetchUrl = job.url;
  if (job.atsSource === 'icims') {
    // Ensure /job path and add in_iframe=1
    // URL format: {base}/jobs/{id}/{slug}
    // Fetch format: {base}/jobs/{id}/job?in_iframe=1
    const iframeUrl = fetchUrl
      .replace(/\/jobs\/(\d+)\/[^?]+/, '/jobs/$1/job')
      .split('?')[0] + '?in_iframe=1';
    fetchUrl = iframeUrl;
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

    // Workday: og:description in meta tag
    const og = html.match(
      /<meta\s+(?:name|property)="(?:og:description|description)"[^>]*content="([^"]{20,})"[^>]*>/i
    ) || html.match(
      /<meta\s+content="([^"]{20,})"[^>]*(?:name|property)="(?:og:description|description)"[^>]*>/i
    );
    if (og) return decodeHtmlEntities(og[1]);

    // JSON-LD schema.org/JobPosting fallback (Workday)
    const ld = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (ld) {
      try {
        const d = JSON.parse(ld[1]);
        const desc = d.description || d.jobDescription;
        if (desc && desc.length > 20) return stripHtml(desc);
      } catch {}
    }

    return '';
  } catch {
    clearTimeout(timeout);
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser Rendering fetch — iCIMS / Taleo
//
// VERIFIED 2026-06-06 via /br-test endpoint:
//   Taleo (TUHS): ✅ WORKS — search SPA yields 20+ real job URLs,
//     detail page renders with full description in DOM body text.
//     og:description is boilerplate — use DOM text selectors instead.
//   iCIMS (VHC, UCI): ❌ IP-BLOCKED — Cloudflare Browser Rendering IPs
//     are blocked at WAF level. VHC returns wrapper site; UCI returns 403.
//     Fallback: iCIMS jobs surface via HiringCafe with description in
//     job_information.description (v5_processed_job_data). Direct iCIMS
//     polling delivers title/location/url only — no description available.
//
// Both are JavaScript SPAs — og:description meta tags are NOT in the server
// HTML. The browser must execute JS to populate the DOM. Browser Rendering
// runs headless Chromium at the edge and returns fully-rendered HTML.
//
// Session reuse pattern: check for idle sessions before launching new browser.
// Avoids launching a fresh browser instance for every fetch, reducing both
// billing time and cold-start latency (~500ms reuse vs ~2s launch).
//
// waitUntil: 'networkidle0' — waits for JS to finish executing before
// extracting content. Appropriate for SPAs that load data via XHR/fetch.
//
// Timeout: 15s — SPAs need more time than static HTML. Falls back gracefully.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchBrowserDescription(job, env) {
  if (!job.url || !env.MYBROWSER) return '';

  let browser = null;
  let reused  = false;

  try {
    // Try to reuse an existing idle browser session first
    const sessions = await puppeteer.sessions(env.MYBROWSER);
    const idle = sessions.filter(s => !s.connectionId);

    if (idle.length > 0) {
      try {
        browser = await puppeteer.connect(env.MYBROWSER, idle[0].sessionId);
        reused = true;
      } catch {
        // Session went away — fall through to launch
      }
    }

    if (!browser) {
      browser = await puppeteer.launch(env.MYBROWSER);
    }

    const page = await browser.newPage();

    // Suppress images/fonts to speed up SPA load
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(job.url, {
      waitUntil: 'networkidle0',
      timeout:   15_000,
    });

    // Extract description after JS executes.
    // Taleo og:description is always boilerplate ("Click the link to see...").
    // Real description is in the rendered body text — use DOM selectors.
    const atsSource = job.atsSource;
    const description = await page.evaluate((ats) => {
      const og = document.querySelector(
        'meta[property="og:description"], meta[name="og:description"]' +
        ', meta[name="description"]'
      );
      const ogContent = og?.content ?? '';

      // Taleo og:description is boilerplate — skip it
      const ogUsable = ats !== 'taleo' && ogContent.length > 50 &&
        !ogContent.toLowerCase().includes('click the link');

      if (ogUsable) return ogContent;

      // DOM text: job description containers, then body text
      const selectors = [
        '.job-description', '#job-description', '[class*="description"]',
        '.job-content', '#job-content',
        // Taleo-specific: main content section
        '#mainContent', '.requisitionDescriptionInterface',
        'main', 'article',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        const text = el?.innerText?.trim();
        if (text && text.length > 100) return text.slice(0, 3000);
      }

      // Last resort: body text after navigation header
      const body = document.body?.innerText?.trim() ?? '';
      const mainIdx = body.indexOf('Beginning of the main content');
      if (mainIdx > 0) return body.slice(mainIdx + 40, mainIdx + 3040);
      return body.slice(0, 3000);
    }, atsSource);

    await page.close();

    // Disconnect (not close) to keep session alive for reuse
    await browser.disconnect();

    console.log(`[STAT enrich] Browser fetch ${reused ? '(reused)' : '(new)'} ${job.atsSource}: ${description.length} chars`);
    return description ? decodeHtmlEntities(description) : '';

  } catch (e) {
    console.warn(`[STAT enrich] Browser fetch failed for ${job.url}: ${e.message}`);
    // Close (not disconnect) on error to avoid leaving broken session
    if (browser) {
      try { await browser.close(); } catch {}
    }
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
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
