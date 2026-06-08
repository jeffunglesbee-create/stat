# STAT HANDOFF — 2026-06-08 (S9/S10 boundary)

## State
HEAD: ed48bd9
Smoke: 65/65 ✅
CI: green (run #123)

## This Session — Full Changelog

### New Adapters
- Oracle HCM adapter — Cedars-Sinai live, closes open item #10 (`7b3483a`)
- Infor CloudSuite HCM adapter — 8 health systems seeded (`2651c32`)
- Jobhive CSV hourly cron scan — streaming O(1) CSV parser for Epic role
  auto-discovery at unknown companies (`68563a3`, `f99b5dd`)

### Major Architecture Changes
- **Workday: retire BR + DataImpulse + XHR intercept** (`8917942`)
  Plain HTML GET + ?q=epic on listing URL. Server-side rendering confirmed.
  ~200-500ms vs 3-5s. No BR quota. No proxy creds. 121 companies affected.
- **HiringCafe: searchState SSR** (`145ff6b`)
  ?searchState= is server-side — returns keyword-filtered hits, not global feed.
  Replaces the confirmed-no-op ?q= approach. ssrTotalCount reflects real count.
- **Taleo: retire BR for detail pages** (`2a3f197`)
  initialHistory hidden input parsed in fetchTaleo() — title, location, salary
  all extracted from it. NEEDS_BROWSER_FETCH is now empty.
- **HiringCafe: v5 structured matching + description second-pass** (`3f4e293`)
  mapHiringCafeHit() shared between SSR and BR paths. Full v5 field mapping.
  fetchHcDescription() for matched jobs.
- **HC enrichment parity** (`17fba20`)
  HC match path now runs liveness, salary enrichment, MD scoring, saveRecentMatches.
  Previously HC matches were surface-level; now full pipeline.

### New Endpoints
- POST /html-probe — fetch any URL from CF IP, return structured HTML analysis
  (visibleText, metaTags, jsonLd, frameworks, dataAutomationIds, hiddenInputs)
  Generic ATS reverse engineering. Key for probing unknown ATSes.
- POST /hc-probe — fetch any HC URL from CF IP, return __NEXT_DATA__
- GET /jobhive-scan, /jobhive-sample, /jobhive-manifest — Jobhive diagnostic tools
- GET /logs — alarm log buffer (already existed; confirmed accessible)

### Infrastructure
- Worker log buffer + GET /logs (`977604f`)
  Rolling alarm log in StateStoreDO. CI log-check workflow reads + pushes to outbox.
- Email throttle (`004074b`)
  Queue-based. Max once per 4 hours. Max 6 emails/day on Resend free tier.
- Geo filter in passesEnvFilter (`460e213`)
  isNonUsLocation() before env filter. HC uses v5.workplaceStates. Conservative.
- jobhive first-alert (`20a97c5`)
  Discovered jobs fire P3 email dispatch immediately (not just promotion).
- URL→ATS auto-detection (`79496d2`)
  POST /detect-ats {url} → {ats, token, url}. Also fires from match paths.
- Auto-discovery from all match paths + healthcare gate (`e0f1332`)

### Bugfixes
- Workday full JD: JSON-LD first, DOM second, og:description last (`e8f9672`)
- iCIMS URL construction: preserve slug, drop regex (`692ca32`)
- SF XML description: strip literal \r\n sequences (`5f0ae85`)
- UPMC: workday → taleo (upmcjobs.taleo.net/careersection/UPMC_External) (`c53302e`)
- Atrium: aah tenant (post-merger), Northwell: workday → iCIMS (`dbcbc30`)
- Stanford Health Care: → Workday wd115 (not SuccessFactors) (`33973ab`)
- Advocate Aurora + Atrium SF entries removed (same parent as aah Workday) (`b9a5851`)
- +26 SAP SuccessFactors health systems seeded (`cbbe89f`)
- notify.js restore: corrupted by bad Python splice in v5 match insertion (`e444842`)
- Jobhive CSV parser: quote-aware stream + carryInQuote across chunks (`fe8bfcd`, `7a8f3cc`)

### Documentation
- Rule 16 committed: never defend work that fails to produce results (`c358e0a`)
- STAT-CURRENT-STATE.txt: full rewrite reflecting all changes
- STAT-ADAPTERS.txt: Oracle HCM, Infor HCM, Jobhive specs added; all adapter changes
- STAT-ARCHITECTURE.txt: all new decisions, pipeline updates, enrich.js routing

## Open Items

- **#7 Feedback loop** — Applied/Skip buttons built (2026-06-07); verify they feed
  Claude review context correctly end-to-end.
- **#8 seen_ids expiry** — no TTL; 5000 cap prevents runaway. Consider 30-day TTL.
- **#11 STAT_KV dead binding** — old KV namespace still in wrangler.toml. Remove.
- **SelectMinds adapter** — host allowlist not yet implemented.
- **Avature adapter** — UCSF (careers.ucsf.edu, portal ID=9). POST /html-probe to find API.
- **Phenom People** — UMiami (careers.miami.edu, UOMUOMUS). Wraps Workday.
- **Taleo tbe.taleo.net** — Mount Sinai (phg.tbe.taleo.net). May differ from taleo.net.
- **Oracle HCM — Tenet** — eodr.fa.us2.oraclecloud.com, site path unknown. Needs probe.
- **Infor HCM verification** — Lee Health confirmed. Other 7 tenants seeded by pattern;
  not individually verified.
- **Workday broad verification** — plain HTML GET confirmed for Advocate Health.
  Run spot checks across a few other Workday seed companies to confirm parity.

## Recovery Escape Hatches (manual — do NOT automate)
- POST /bootstrap → Bootstrap watchers (cold recovery only)
- POST /trigger → HiringCafe scan now (immediate trigger only)
- POST /backfill-browse → Backfill Browse (store recovery only)
- POST /salary-refresh → Salary refresh (cron handles normally)
- POST /reset-seen → Clear seen IDs (nuclear, intentional)

## Seed Company Count
271 total: Workday 121, Greenhouse 81, SuccessFactors 28, Lever 14,
Infor HCM 8, iCIMS 7, Taleo 5, Ashby 5, Oracle HCM 2.
