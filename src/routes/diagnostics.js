import { json } from './_utils.js';
import puppeteer from '@cloudflare/puppeteer';
import { SEED_COMPANIES } from '../config.js';
import { getStatStore, readLog, loadRecentMatches } from '../store.js';
import { loadCompanyList } from '../state.js';

export async function handleDiagnostics(request, url, env) {
  // GET /workday-health — per-company Workday telemetry for the S21b audit
  // Read-only: aggregates the rolling 200-entry log buffer + recent_matches
  // store into one row per Workday company. No new fetches, no Workday hits.
  //
  // Per-row fields:
  //   name, url, inactive, inactiveReason
  //   totalPolls    — how many alarm cycles polled this company (≤200)
  //   totalJobs     — sum of jobs returned across those polls
  //   lastPollTs    — most recent alarm timestamp this company was polled
  //   lastJobsSeenTs — most recent alarm where jobs > 0
  //   jobsInLastPoll — jobs returned at the most recent poll
  //   matchCount    — count of recent_matches whose job.company == name
  if (url.pathname === '/workday-health' && request.method === 'GET') {
    const store = getStatStore(env);
    const [companies, logs, matches] = await Promise.all([
      loadCompanyList(env).catch(() => null),
      readLog(store, 200).catch(() => []),
      loadRecentMatches(store).catch(() => []),
    ]);
    const list = (companies ?? SEED_COMPANIES).filter(c => c.ats === 'workday');

    const matchesByCompany = Object.create(null);
    for (const m of (matches ?? [])) {
      const cname = m?.job?.company ?? m?.job?._company;
      if (!cname) continue;
      matchesByCompany[cname] = (matchesByCompany[cname] ?? 0) + 1;
    }

    const out = list.map(c => {
      let totalPolls = 0, totalJobs = 0;
      let lastPollTs = null, lastJobsSeenTs = null, jobsInLastPoll = null;
      for (const log of logs) {
        if (log.ats !== 'workday' || !Array.isArray(log.br)) continue;
        const brEntry = log.br.find(b => b.company === c.name);
        if (!brEntry) continue;
        totalPolls++;
        totalJobs += brEntry.jobs;
        if (lastPollTs === null) {
          lastPollTs = log.ts;
          jobsInLastPoll = brEntry.jobs;
        }
        if (brEntry.jobs > 0 && lastJobsSeenTs === null) {
          lastJobsSeenTs = log.ts;
        }
      }
      return {
        name: c.name,
        url: c.url,
        inactive: !!c.inactive,
        inactiveReason: c.inactiveReason ?? null,
        totalPolls,
        totalJobs,
        lastPollTs,
        lastJobsSeenTs,
        jobsInLastPoll,
        matchCount: matchesByCompany[c.name] ?? 0,
      };
    });

    return json({
      count: out.length,
      logsAvailable: logs.length,
      generatedAt: new Date().toISOString(),
      companies: out,
    });
  }

  // GET /raw-fetch?url=… — return the full body of a URL fetched from the
  // Worker IP. Used by the S21b/S22 Workday SSR investigation: /plain-fetch-test
  // only returns a 300-char excerpt, which isn't enough to inspect Workday's
  // real link patterns. Same headers as fetchWorkday in adapters.js so the
  // response matches what the adapter actually sees.
  //
  // Returns raw HTML (Content-Type: text/plain) with X-Status / X-Bytes
  // headers carrying the upstream status + length. Up to 250KB.
  if (url.pathname === '/raw-fetch' && (request.method === 'GET' || request.method === 'POST')) {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) return new Response('url param required', { status: 400 });
    try {
      // POST mode: caller supplies body + headers via the request itself.
      // Useful for hitting Workday CXS endpoints with the right Origin/Referer.
      const isPost = request.method === 'POST';
      const targetHost = new URL(targetUrl).host;
      const targetOrigin = `https://${targetHost}`;
      const upstreamHeaders = {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          isPost ? 'application/json' : 'text/html,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      };
      if (isPost) {
        upstreamHeaders['Content-Type'] = request.headers.get('content-type') || 'application/json';
        upstreamHeaders['Origin'] = targetOrigin;
        // Caller can override referer via X-Wanted-Referer header.
        upstreamHeaders['Referer'] = request.headers.get('x-wanted-referer') || `${targetOrigin}/`;
      }
      const upstreamBody = isPost ? await request.text() : undefined;
      const res = await fetch(targetUrl, {
        method: isPost ? 'POST' : 'GET',
        headers: upstreamHeaders,
        body: upstreamBody,
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
      const body = await res.text();
      const truncated = body.slice(0, 250000);
      return new Response(truncated, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Upstream-Status': String(res.status),
          'X-Upstream-Bytes':  String(body.length),
          'X-Truncated':       truncated.length < body.length ? '1' : '0',
        },
      });
    } catch (e) {
      return new Response('error: ' + e.message, { status: 500 });
    }
  }

  // GET /workday-probe — rate limit floor probe for Workday API
  // Tests a single tenant at decreasing intervals and returns results as JSON.
  // Usage: GET /workday-probe?tenant=jhhs&host=jhhs.wd5.myworkdayjobs.com&slug=JHH_External_Positions
  // Takes ~60s to run (6 rounds with sleep gaps).
  if (url.pathname === '/workday-probe' && request.method === 'GET') {
    const tenant = url.searchParams.get('tenant');
    const host   = url.searchParams.get('host');
    const slug   = url.searchParams.get('slug');
    if (!tenant || !host || !slug) {
      return json({ error: 'tenant, host, slug required' }, 400);
    }
    const apiUrl = `https://${host}/wday/cxs/${tenant}/${slug}/jobs`;
    const body = JSON.stringify({
      appliedFacets: {}, limit: 5, offset: 0,
      searchText: 'epic ehr',
    });
    const origin = `https://${host}`;
    const referer = `https://${host}/en-US/${slug}`;
    const hdrs = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; STAT/1.0)',
      // Workday /wday/cxs/ API requires same-origin headers — 422 without them
      'Origin':  origin,
      'Referer': referer,
    };
    const gaps = [0, 30, 10, 5, 2, 1];
    const results = [];
    for (const gap of gaps) {
      if (gap > 0) await new Promise(r => setTimeout(r, gap * 1000));
      const start = Date.now();
      try {
        const res = await fetch(apiUrl, { method: 'POST', headers: hdrs, body });
        const elapsed = Date.now() - start;
        let jobCount = 0;
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          jobCount = data.jobPostings?.length ?? 0;
        }
        results.push({ gap, http: res.status, elapsed, jobs: jobCount,
          verdict: res.ok && jobCount > 0 ? 'OK'
                 : res.ok && jobCount === 0 ? 'SILENT_THROTTLE'
                 : res.status === 429 ? 'RATE_LIMITED' : 'ERROR' });
      } catch (e) {
        results.push({ gap, http: 'ERR', elapsed: Date.now() - start, verdict: 'ERROR', error: e.message });
      }
    }
    const anyThrottle = results.some(r => r.verdict !== 'OK');
    const lowestSafeGap = results.filter(r => r.verdict === 'OK').reduce((min, r) => Math.min(min, r.gap), 30);
    return json({ tenant, results, anyThrottle, lowestSafeGapSeconds: lowestSafeGap });
  }

  // ── GET /plain-fetch-test?url={url} ───────────────────────────────────────
  // Plain Worker fetch() diagnostic — no headless browser.
  // Tests whether Cloudflare Worker IPs are blocked by a given URL.
  // Returns HTTP status, response size, og:description, page title,
  // any job IDs found in href patterns, and a body text excerpt.
  //
  // Critical use: verifying iCIMS in_iframe=1 endpoints are reachable
  // from inside a Worker (Cloudflare IP) without Browser Rendering.
  //
  // Usage:
  //   /plain-fetch-test?url=https://careers-vhchealth.icims.com/jobs/search%3Fss%3D1%26in_iframe%3D1
  //
  if (url.pathname === '/plain-fetch-test' && request.method === 'GET') {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) return json({ error: 'url param required' }, 400);

    const t0 = Date.now();
    try {
      const res = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control':   'no-cache',
        },
        redirect: 'follow',
      });

      const elapsed   = Date.now() - t0;
      const body      = await res.text();
      const bodyLen   = body.length;

      // Extract og:description
      const ogMatch = body.match(/<meta[^>]*(?:property|name)="og:description"[^>]*content="([^"]{10,})"[^>]*>/i)
                   || body.match(/<meta[^>]*content="([^"]{10,})"[^>]*(?:property|name)="og:description"[^>]*>/i);
      const ogDesc  = ogMatch?.[1] ?? '';

      // Page title
      const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title      = titleMatch?.[1]?.trim() ?? '';

      // Job IDs from href patterns — iCIMS: /jobs/{id}/
      const jobIdMatches = [...body.matchAll(/\/jobs\/(\d{4,6})\//g)];
      const jobIds = [...new Set(jobIdMatches.map(m => m[1]))].slice(0, 20);

      // Job hrefs
      const hrefMatches = [...body.matchAll(/href="(\/jobs\/\d+\/[^"?]+)"/g)];
      const jobHrefs = [...new Set(hrefMatches.map(m => m[1]))].slice(0, 10);

      // Body text excerpt (strip tags)
      const bodyText = body
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);

      // Blocked indicators
      const isBlocked = res.status === 403
        || title.includes('403')
        || title.includes('Forbidden')
        || title.includes('Access Denied');

      return json({
        ok:          !isBlocked && res.status < 400,
        url:         targetUrl,
        http_status: res.status,
        elapsed_ms:  elapsed,
        body_bytes:  bodyLen,
        is_blocked:  isBlocked,
        title,
        og_description:   ogDesc.slice(0, 300),
        job_ids:          jobIds,
        job_hrefs:        jobHrefs,
        body_text_excerpt: bodyText.slice(0, 300),
      });

    } catch (e) {
      return json({
        ok:        false,
        url:       targetUrl,
        elapsed_ms: Date.now() - t0,
        error:     e.message,
      }, 500);
    }
  }

  //
  // Usage:
  //   curl "https://stat-job-watcher.*.workers.dev/br-test?url=https://careers-vhchealth.icims.com/jobs/search&ats=icims"
  //
  if (url.pathname === '/br-test' && request.method === 'GET') {
    const targetUrl = url.searchParams.get('url');
    const ats       = url.searchParams.get('ats') ?? 'unknown';
    if (!targetUrl) return json({ error: 'url param required' }, 400);
    if (!env.MYBROWSER) return json({ error: 'MYBROWSER binding not available' }, 500);

    const t0 = Date.now();
    let browser = null;
    try {
      // Try session reuse first
      const sessions = await puppeteer.sessions(env.MYBROWSER);
      const idle = sessions.filter(s => !s.connectionId);
      if (idle.length > 0) {
        try { browser = await puppeteer.connect(env.MYBROWSER, idle[0].sessionId); } catch {}
      }
      if (!browser) browser = await puppeteer.launch(env.MYBROWSER);

      const page = await browser.newPage();

      // Suppress heavy resources to speed up SPA load
      await page.setRequestInterception(true);
      page.on('request', req => {
        const t = req.resourceType();
        if (['image', 'font', 'media', 'stylesheet'].includes(t)) req.abort();
        else req.continue();
      });

      await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 20_000 });

      // Extract everything useful from the rendered DOM
      const extracted = await page.evaluate(() => {
        // og:description or meta description
        const og = document.querySelector(
          'meta[property="og:description"], meta[name="og:description"], meta[name="description"]'
        );
        const ogDesc = og?.content ?? '';

        // Page title
        const title = document.title ?? '';

        // All job-like links (iCIMS: /jobs/{id}/..., Taleo: jobdetail.ftl?job=...)
        const allLinks = [...document.querySelectorAll('a[href]')]
          .map(a => a.href)
          .filter(h => h && (
            h.includes('/jobs/') ||
            h.includes('jobdetail') ||
            h.includes('jobId=') ||
            h.includes('job=') ||
            h.includes('requisition')
          ))
          .slice(0, 20);

        // Visible text from likely job containers
        const jobText = [...document.querySelectorAll(
          '[class*="job"], [class*="position"], [class*="listing"], ' +
          '[id*="job"], [id*="search-results"], main, article'
        )]
          .map(el => el.innerText?.trim())
          .filter(t => t && t.length > 30)
          .slice(0, 3)
          .join('\n---\n');

        // DOM text excerpt from body (first 1000 chars of visible text)
        const bodyText = document.body?.innerText?.trim().slice(0, 1000) ?? '';

        // Count of elements that look like job cards
        const cardCount = document.querySelectorAll(
          '[class*="job-card"], [class*="job_card"], [class*="jobCard"], ' +
          '[class*="result-item"], [class*="posting"]'
        ).length;

        return { ogDesc, title, allLinks, jobText, bodyText, cardCount };
      });

      await page.close();
      await browser.disconnect();

      const elapsed = Date.now() - t0;
      return json({
        ok:       true,
        ats,
        url:      targetUrl,
        elapsed_ms: elapsed,
        title:    extracted.title,
        og_description: extracted.ogDesc,
        job_links: extracted.allLinks,
        job_card_count: extracted.cardCount,
        dom_text_excerpt: extracted.bodyText.slice(0, 500),
        job_container_text: extracted.jobText.slice(0, 500),
      });

    } catch (e) {
      if (browser) { try { await browser.close(); } catch {} }
      return json({ ok: false, ats, url: targetUrl, error: e.message, elapsed_ms: Date.now() - t0 }, 500);
    }
  }

  // ── POST /html-probe — fetch any URL from CF IP, return raw HTML ────────────
  // Generic version of /hc-probe for reverse engineering any ATS page.
  // CF Worker IPs bypass WAFs that block GitHub runner IPs (Workday, HC, etc.)
  //
  // Body: { url: string, maxBytes?: number }
  // Returns: {
  //   ok, url, httpStatus, bytes, contentType,
  //   visibleText,    // stripped body text (first 3000 chars)
  //   metaTags,       // og:title, og:description, etc.
  //   jsonLd,         // parsed application/ld+json if present
  //   scriptIds,      // id attrs on <script> tags (framework detection)
  //   dataAutomationIds, // data-automation-id values (Workday/Oracle detection)
  //   hiddenInputs,   // name+value of hidden <input> fields (Taleo/SF patterns)
  //   htmlSnippet,    // first 2000 chars of raw HTML
  // }
  //
  // Usage via FIELD relay (MCP):
  //   POST /stat/html-probe { "url": "https://aah.wd5.myworkdayjobs.com/en-US/External?q=epic" }
  if (url.pathname === '/html-probe' && request.method === 'POST') {
    let targetUrl, maxBytes;
    try {
      const body = await request.json();
      targetUrl = body.url;
      maxBytes = body.maxBytes ?? 500_000;
      if (!targetUrl || !targetUrl.startsWith('http')) {
        return json({ ok: false, error: 'url required and must start with http' }, 400);
      }
    } catch (e) {
      return json({ ok: false, error: 'invalid JSON body' }, 400);
    }

    try {
      const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      const res = await fetch(targetUrl, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
        redirect: 'follow',
      });

      const httpStatus = res.status;
      const contentType = res.headers.get('content-type') ?? '';
      let html = await res.text();
      if (html.length > maxBytes) html = html.slice(0, maxBytes);
      const bytes = html.length;

      if (!res.ok) {
        return json({ ok: false, url: targetUrl, httpStatus, bytes, contentType,
          error: `HTTP ${httpStatus}` });
      }

      // 1. Visible text (strip scripts/styles/tags)
      const visibleText = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ').trim().slice(0, 3000);

      // 2. Meta tags
      const metaTags = {};
      for (const m of html.matchAll(/<meta[^>]+>/gi)) {
        const tag = m[0];
        const nameM = tag.match(/(?:name|property)="([^"]+)"/i);
        const contM = tag.match(/content="([^"]{0,500})"/i);
        if (nameM && contM) metaTags[nameM[1]] = contM[1];
      }

      // 3. JSON-LD
      let jsonLd = null;
      const ldMatch = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i);
      if (ldMatch) {
        try { jsonLd = JSON.parse(ldMatch[1].trim()); } catch {}
      }

      // 4. Script tag IDs (framework detection)
      const scriptIds = [...html.matchAll(/<script[^>]+id="([^"]+)"/gi)].map(m => m[1]).slice(0, 20);

      // 5. data-automation-id values (Workday/Oracle/Infor pattern)
      const dataAutomationIds = [...new Set(
        [...html.matchAll(/data-automation-id="([^"]+)"/gi)].map(m => m[1])
      )].slice(0, 30);

      // 6. Hidden inputs (Taleo initialHistory, SF form state, etc.)
      const hiddenInputs = [];
      for (const m of html.matchAll(/<input[^>]+type="hidden"[^>]*>/gi)) {
        const tag = m[0];
        const nameM = tag.match(/name="([^"]+)"/i);
        const idM   = tag.match(/id="([^"]+)"/i);
        const valM  = tag.match(/value="([^"]{0,200})"/i);
        if ((nameM || idM) && valM) {
          hiddenInputs.push({
            name: nameM?.[1] ?? idM?.[1],
            value: valM[1].slice(0, 200),
          });
        }
      }

      // 7. Framework signals
      const frameworks = {};
      for (const [kw, label] of [
        ['__NEXT_DATA__', 'nextjs'], ['_ngcontent', 'angular'], ['ember', 'ember'],
        ['data-bind=', 'knockout'], ['react-dom', 'react'], ['workday', 'workday'],
        ['inforcloudsuite', 'infor'], ['oraclecloud', 'oracle'], ['taleo', 'taleo'],
        ['successfactors', 'successfactors'], ['application/ld+json', 'json-ld'],
      ]) {
        const count = (html.match(new RegExp(kw, 'gi')) ?? []).length;
        if (count > 0) frameworks[label] = count;
      }

      return json({
        ok: true, url: targetUrl, httpStatus, bytes, contentType,
        visibleText,
        metaTags,
        jsonLd,
        scriptIds,
        dataAutomationIds,
        hiddenInputs: hiddenInputs.slice(0, 20),
        frameworks,
        htmlSnippet: html.slice(0, 2000),
      });
    } catch (e) {
      return json({ ok: false, url: targetUrl, error: e.message });
    }
  }

  // ── POST /hc-probe — fetch any HC URL from CF IP, return __NEXT_DATA__ ─────
  // Used for one-off probes of HC listing/search pages.
  // HC blocks GitHub runner IPs; CF Worker IPs are not blocked.
  // Body: { url: string }
  // Returns: { ok, url, nextData, ssrKeys, ssrHitsCount, ssrTotalCount,
  //            ssrPageSize, ssrIsLastPage, hitsHaveV5, algoliaSignals,
  //            httpStatus, bytes }
  if (url.pathname === '/hc-probe' && request.method === 'POST') {
    let targetUrl;
    try {
      const body = await request.json();
      targetUrl = body.url;
      if (!targetUrl || !targetUrl.includes('hiring.cafe')) {
        return json({ ok: false, error: 'url must be a hiring.cafe URL' }, 400);
      }
    } catch (e) {
      return json({ ok: false, error: 'invalid JSON body' }, 400);
    }

    try {
      const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      const res = await fetch(targetUrl, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      const httpStatus = res.status;
      const html = await res.text();
      const bytes = html.length;

      // Extract __NEXT_DATA__
      const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!ndMatch) {
        return json({ ok: false, url: targetUrl, httpStatus, bytes, error: 'no __NEXT_DATA__ found' });
      }

      const nextData = JSON.parse(ndMatch[1]);
      const pp = nextData?.props?.pageProps ?? {};
      const ssrKeys = Object.keys(pp);

      // Listing page signals
      const ssrHits = pp.ssrHits ?? [];
      const ssrHitsCount = ssrHits.length;
      const ssrTotalCount = pp.ssrTotalCount ?? null;
      const ssrPageSize = pp.ssrPageSize ?? null;
      const ssrIsLastPage = pp.ssrIsLastPage ?? null;
      const ssrPage = pp.ssrPage ?? null;
      const ssrError = pp.ssrError ?? null;
      const initialSearchState = pp.initialSearchState ?? null;
      const ssrTimings = nextData?.ssrTimings ?? null;

      // Check if ssrHits contain v5_processed_job_data
      const hitsHaveV5 = ssrHits.length > 0 && 'v5_processed_job_data' in ssrHits[0];
      const hitsHaveEnriched = ssrHits.length > 0 && 'enriched_company_data' in ssrHits[0];
      const hitsHaveDesc = ssrHits.length > 0 && !!(ssrHits[0]?.job_information?.description);

      // Algolia signals: objectID field, _geoloc field
      const algoliaSignals = {
        hasObjectId: ssrHits.length > 0 && 'objectID' in ssrHits[0],
        hasGeoloc: ssrHits.length > 0 && '_geoloc' in ssrHits[0],
        pageObjectId: 'objectID' in (pp.job ?? {}),
      };

      // Sample first hit (stripped for size)
      let firstHitSample = null;
      if (ssrHits.length > 0) {
        const h = ssrHits[0];
        firstHitSample = {
          id: h.id,
          objectID: h.objectID,
          source: h.source,
          board_token: h.board_token,
          requisition_id: h.requisition_id,
          collapse_key: h.collapse_key,
          is_expired: h.is_expired,
          title: h.job_information?.title,
          v5_keys: h.v5_processed_job_data ? Object.keys(h.v5_processed_job_data) : null,
          enriched_keys: h.enriched_company_data ? Object.keys(h.enriched_company_data) : null,
          hc_geoloc: h._geoloc,
        };
      }

      // Check for Algolia credentials in page HTML
      const algoliaCredsInHtml = {
        algoliaNet: /[a-zA-Z0-9]{10}\.algolia\.net/.test(html),
        algoliaAppId: /X-Algolia-Application-Id/.test(html),
        algoliaApiKey: /X-Algolia-API-Key/.test(html),
        algoliaInstantSearch: /instantsearch|algoliasearch/i.test(html),
        appIdPattern: (html.match(/[A-Z0-9]{10}(?=\.algolia)/g) ?? []),
      };

      // Pagination signals from URL params or HTML
      const paginationSignals = {
        pageParam: /[?&]page=\d+/.test(targetUrl),
        offsetParam: /[?&]offset=\d+/.test(targetUrl),
        ssrPage,
        ssrIsLastPage,
        nextPageHint: pp.nextPage ?? pp.nextCursor ?? null,
      };

      // searchState from URL
      let parsedSearchState = null;
      try {
        const searchStateParam = new URL(targetUrl).searchParams.get('searchState');
        if (searchStateParam) parsedSearchState = JSON.parse(decodeURIComponent(searchStateParam));
      } catch {}

      return json({
        ok: true,
        url: targetUrl,
        httpStatus,
        bytes,
        buildId: nextData.buildId,
        page: nextData.page,
        query: nextData.query,
        gsp: nextData.gsp,
        ssrKeys,
        ssrHitsCount,
        ssrTotalCount,
        ssrPageSize,
        ssrIsLastPage,
        ssrPage,
        ssrError,
        ssrTimings,
        hitsHaveV5,
        hitsHaveEnriched,
        hitsHaveDesc,
        algoliaSignals,
        algoliaCredsInHtml,
        paginationSignals,
        parsedSearchState,
        initialSearchState,
        firstHitSample,
      });
    } catch (e) {
      return json({ ok: false, url: targetUrl, error: e.message }, 500);
    }
  }


  return null;
}
