# STAT HANDOFF — 2026-06-08 (Session 10 END)

## State
HEAD: 962e2fd
Smoke: 89/89 ✅
CI: green (run #128)

## This Session — Full Changelog

### SelectMinds Adapter (UTMB Health) — closes S9 open item
- `bfb7ce2` feat: SelectMinds adapter — sequential ID walk, plain fetch detail pages
  - `fetchSelectMinds()` in adapters.js; `SelectMindsDO` class; wrangler v7 migration
  - UTMB Health seeded (aa083s01.upgrade.selectminds.com/utmb, token '1000')
  - enrich.js: selectminds in NEEDS_PLAIN_FETCH, body text after "Requisition #"
- `a3ac5a4` fix: bootstrapDOs seed merge + selectminds in PLATFORM_MAP
  - bootstrapDOs now merges SEED_COMPANIES into stored list (new seeds picked up automatically)
  - PLATFORM_MAP in /platform/:ats/status route updated with selectminds
- `3610de5` fix: SelectMinds full-range cursor walk (1000→3300), skip closed jobs
  - Cursor wraps at MAX_ID; detects "position has been closed" HTML pattern

### seen_ids TTL + Ghost Resurrection + Cron Sweep — closes #8
- `962e2fd` feat: seen_ids TTL + ghost resurrection + cron sweep
  - Format change: `string[]` → `Map<id, {id, seenAt, diedAt?, url?}>`
  - 30-day TTL prunes dead entries; 90-day hard cap on live entries
  - Ghost resurrection: `diedAt` entries re-enter pipeline when liveness returns live
  - Cron sweep: `maybeRunSeenSweep()` — 20 dead entries/tick via HEAD, cursor persists
  - URL from match history first (recent_matches stores job.url); falls back to stored url field
  - Backward compat: raw string entries parsed as `{id, seenAt: epoch0}`
  - All paths updated: HC cron, platform-do alarm loop, jobhive, backfill-browse

### Documentation Pass (pre-session)
- docs/STAT-CURRENT-STATE.txt — full rewrite for all S9/S10 changes
- docs/STAT-ADAPTERS.txt — Oracle HCM, Infor HCM, Jobhive, Workday plain GET, HC searchState
- docs/STAT-ARCHITECTURE.txt — full pipeline, all decisions, enrich.js routing
- HANDOFF.md — S9/S10 boundary document

### CI Infrastructure
- worker-probe: added workflow_dispatch + fixed YAML (inline Python was invalid)
- Fixed [skip ci] blocking non-deploy workflow triggers (lesson: outbox trigger commits need no [skip ci])

## SelectMinds Status (as of session end)
DO: live, polling every 8 min
lastRun: 2026-06-08T20:11:31Z
seenCount: 130 (IDs 1000–1120 scanned so far)
totalMatches: 0 — IT job IDs not yet reached; full 1000–3300 range takes ~5 hours

## Open Items

**Verify next session:**
- SelectMinds first match — confirm totalMatches > 0 after full ID range sweep
  If still 0 after one full cycle (~5 hrs), debug keyword match vs actual job format
- seen_ids backward compat — confirm Worker started cleanly with mixed old/new format
  (2057 existing string entries will be auto-migrated on first read)

**Open from prior sessions:**
- #7  Feedback loop — Applied/Skip buttons built; verify end-to-end Claude context update
- #11 STAT_KV dead binding — remove from wrangler.toml (cleanup, no functional impact)
- Tenet Healthcare Oracle HCM — site ID unknown; one html_probe closes it
- Avature (UCSF) — one html_probe to find feed endpoint
- Taleo tbe.taleo.net (Mount Sinai) — probe needed
- Infor HCM: 7 of 8 tenants seeded but unverified

**Longer term:**
- Competitive intelligence features — 4 specs in Drive, none built
  (Drive: 1E7JsGnXe78rNw2L6DZIKoVIbt1C8Hn-BNbW8iv3dSEU, 1tjnFl-..., 1kOOc_..., 1fAi38...)
- seen_ids LIVE_MAX_MS (90-day): review after 3 months of operation
- SelectMinds MAX_ID (3300): update when UTMB posts jobs above that ID

## Recovery Escape Hatches
- POST /bootstrap → Bootstrap watchers (cold recovery only)
- POST /trigger → HiringCafe scan now
- POST /backfill-browse → Rebuild Browse tab
- POST /salary-refresh → Salary refresh (cron handles normally)
- POST /reset-seen → Clear seen IDs (nuclear)

## Seed Company Count
271 seed + manually added = 471 total watched
ATS breakdown: Workday 121, Greenhouse 81, SuccessFactors 28, Lever 14,
Infor HCM 8, iCIMS 7, Taleo 5, Ashby 5, Oracle HCM 2, SelectMinds 1
