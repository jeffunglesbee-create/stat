# STAT HANDOFF — 2026-06-06 (Session END)

## State
HEAD: (updating on commit)
Smoke: 17/17

## This Session — Full Changelog

### Bugs Fixed
- Browse tab never populating after first poll cycle (ROOT: unmatchedJobs capture was after dedup gate)
- Browse Refresh button did nothing (ROOT: tab never called loadBrowse on activation)
- Hardcoded "remote/hybrid, no keyword match" label caused false diagnosis of DO polling failure
- BLS salary parser fetched JS-rendered HTML pages (returned empty) — switched to flat file + series API
- LCA salary parser decoded XLSX binary as UTF-8 (ZIP compression, never found XML) — rewrote with proper ZIP scanner + DecompressionStream
- salaryRaw never set on ATS jobs — peer pool only populated from HiringCafe

### Governance Added
- STANDARDS.md created (Rules 1–15)
- smoke.js created (17 assertions, blocks commits)
- HANDOFF.md created (this file)
- Pre-commit hook wired
- CI smoke step added to deploy.yml

### Automation Added
- maybeRefreshSalaryCaches() in cron — BLS/LCA auto-refresh, zero manual intervention
- Salary status row in UI sidebar — live cache health visible at a glance
- visibilitychange listener — auto-refresh on foreground resume from home screen
- companies tab now loads on activation (was stale on revisit)

### Rules 13–15 (this commit)
- Rule 13: Automation is architecture — full pipeline contract, legitimate manual vs recovery
- Rule 14: System contract is holistic — full pipeline diagram, cross-cutting invariants
- Rule 15: UI labels must reflect live state — lying UI rule with session violation documented

## Open Items
- Browser-verify Browse auto-populates across all 8 ATS platforms
- Browser-verify salary sidebar row shows "active" after deploy + one cron cycle
- Verify LCA XLSX parser works against live FY26 Q2 file (DecompressionStream path)
- BLS series ID format should be verified against live oe.data.0.Current response

## Recovery Escape Hatches (manual buttons — do NOT automate these)
- POST /bootstrap → Bootstrap watchers (cold recovery only)
- POST /trigger → HiringCafe scan now (immediate trigger only)
- POST /backfill-browse → Backfill Browse (store recovery only, marked Rule 11)
- POST /salary-refresh → Salary refresh (immediate trigger, cron handles normally)
- POST /reset-seen → Clear seen IDs (nuclear, intentional user action)
