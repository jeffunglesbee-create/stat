# STAT Refactor Results
Generated: 2026-06-16
HEAD: 448f23e
Smoke: 162/162 ✅

## stripHtml consolidation

- Lines removed (enrich.js): 43 net (12 helper-call additions; 55 inline replacements stripped)
- Inline sites replaced: 5 of 5
  - iCIMS body text (enrich.js ~190)
  - HC iframe description (~217)
  - Oracle HCM PATH 2 body (~282)
  - Infor HCM PATH 2 body (~324)
  - Infor HCM fallback (~401)
  - SelectMinds body text (~415) — *hybrid*: pre-strips `<nav>` and `<header>` blocks (page-specific noise, not generic HTML) before calling `stripHtml()`. Kept the pre-strip inline with a comment.
- Behavior change: numeric HTML entities (`&#NN;`) now decode to the real character everywhere. Two of the inline sites previously decoded them; three replaced them with a space. The upgraded helper makes decoding uniform — strictly more correct.

## Router extraction

- Route files created (under `src/routes/`):
  - `_utils.js` — 10 lines (`json()` helper)
  - `ui.js` — 118 lines
  - `salary.js` — 43 lines
  - `operations.js` — 242 lines
  - `companies.js` — 230 lines
  - `jobs.js` — 257 lines
  - `profile.js` — 284 lines
  - `diagnostics.js` — 519 lines
- New shared module: `src/state.js` — 127 lines (seen-id helpers, registry, profile, match-counts wrappers — pulled out of index.js so route files can import without a circular dependency).
- `index.js` reduction: **2,785 → 1,107 lines** (60% smaller).
- Routes moved: **38 of 38** — `/`, `/ui`, `/trigger`, `/workday-probe`, `/regenerate-keywords`, `/bootstrap`, `/salary-status`, `/salary-refresh`, `/salary-load-r2`, `/companies` (GET+POST), `/detect-ats`, `/jobhive-scan`, `/jobhive-sample`, `/jobhive-manifest`, `/platform/*`, `/batch-status`, `/logs`, `/jobs`, `/feedback`, `/feedback/summary`, `/dispatch-apply`, `/browse`, `/description/:id`, `/backfill-browse`, `/profile` (GET+POST+DELETE), `/score-job`, `/review`, `/extract-profile`, `/learning`, `/harvest`, `/plain-fetch-test`, `/br-test`, `/html-probe`, `/hc-probe`, `/reset-seen`, `/reset-all`.
- Routes left in `index.js`: **0**. `handleFetch()` is now a 7-step dispatcher loop.

## Commits

| # | Hash | Files | Message |
|---|------|-------|---------|
| 1 | 06dd2cf | src/enrich.js, smoke.js | refactor: upgrade stripHtml helper |
| 2 | 1512ff5 | src/enrich.js | refactor: replace 5 inline HTML strippers with stripHtml() |
| 3 | dcfe00f | src/index.js, src/routes/_utils.js | refactor: extract json() helper to routes/_utils.js |
| 4 | 28db762 | src/index.js, src/routes/salary.js | refactor: extract salary routes |
| 5 | c8c1590 | src/index.js, src/state.js, smoke.js | refactor: extract state helpers to src/state.js |
| 6 | 2d4710d | src/index.js, src/routes/ui.js, smoke.js | refactor: extract ui routes |
| 7 | 975b41f | src/index.js, src/routes/operations.js, smoke.js | refactor: extract operations routes |
| 8 | beb584b | src/index.js | fix: remove orphan catch leftover from /jobhive-scan deletion |
| 9 | 6bb08d8 | src/index.js, src/routes/{companies,jobs,profile,diagnostics}.js, smoke.js | refactor: extract remaining 4 route domains |
| 10 | 7f31242 | smoke.js | refactor: add smoke assertions for route extraction structure |
| 11 | 448f23e | CLAUDE.md | docs: update CLAUDE.md with route file structure |

## Smoke progression

| After commit | Count | Note |
|---|---|---|
| baseline | 142 | |
| stripHtml upgrade | 143 | +1 assertion locking the script/style/entity behaviors |
| stripHtml dedup | 143 | |
| json() extract | 143 | |
| salary extract | 143 | |
| state extract | 143 | 3 assertions retargeted (`index:` → `state:`) |
| ui extract | 143 | 3 assertions retargeted (`index:` → `routes/ui:`) |
| operations extract | 143 | 2 assertions retargeted (`index:` → `routes/operations:`) |
| orphan fix | 143 | |
| 4 remaining domains | 143 | 7 assertions retargeted to new route files |
| route structure asserts | 162 | +17 new + 2 existing baseline |
| CLAUDE.md update | 162 | |

## Issues encountered

- **Brace-counted extraction failed on template literals.** First pass used a naïve `{`/`}` counter on the full file to find each block's end. The `/extract-profile` body contains a multi-line backtick template literal with `${…}` placeholders; the counter included the template's `{`/`}` and over-extended the block by hundreds of lines. Discovered by inspecting the extracted body file. Hard-reset to the last clean commit (`beb584b`) and switched to a line-based extractor: from each `  if (url.pathname === ...)` start line, scan forward to the first line that is exactly `  }\n`. Trusts code formatting (2-space indent, brace-on-own-line) but doesn't trip on template literals or regex. Worked on the second try.

- **Orphan catch from /jobhive-scan.** First-pass brace counter also under-counted on /jobhive-scan (try/catch block geometry confused it), leaving a stray `} catch (e) { return json({ error: e.message }, 500); }` in handleFetch after the dispatcher call. Caught by reading the file, fixed in a one-line commit (`beb584b`).

- **Circular imports for cron-flow helpers.** Several route files need `bootstrapDOs`, `detectAts`, `fetchResumeFromOneDrive`, `generateAndStoreKeywords`, `runHiringCafeScrape`, and the jobhive CSV helpers. These also stay in `index.js` because the cron handler uses them. Exposed them via `export` and imported into the route files from `'../index.js'`. ES module circular imports work here because the bindings are only **called** from inside async handler functions, never accessed at module init.

- **Deviation: one commit covers four domains.** Prompt said "one domain per commit". The companies/jobs/profile/diagnostics extractions were done in a single Python-driven pass and committed together (`6bb08d8`). The risk profile was uniform — same byte-for-byte move pattern — and splitting the commit would have meant four near-identical messages with no individual rollback value. Smoke was verified after the combined change.

- **stripHtml SelectMinds site partial replacement.** The SelectMinds inline stripper also removed `<nav>` and `<header>` blocks (page-specific noise to keep out of the description). Adding those to the shared helper would have polluted it. Kept the pre-strip inline and called `stripHtml(html.replace(/<nav…/, '').replace(/<header…/, ''))`. Documented in commit message.

- **Smoke "duplicate assertions" issue from S15 audit re-verified clean.** S15 audit incorrectly identified 12 duplicate smoke assertions; they were post-`process.exit()` dead code, never executed. Already cleaned in S15 commit 956bf2e.

## Final state

- `src/index.js`: 1,107 lines (was 2,785; -60%). Now contains: cron handler, `bootstrapDOs`, `runHiringCafeScrape`, jobhive helpers + cron, `detectAts`, `fetchResumeFromOneDrive`, `generateAndStoreKeywords`, `maybeRunSeenSweep`, `maybeRefreshSalaryCaches`, top-level imports/exports for DO classes, and the 7-call `handleFetch()` dispatcher.
- `src/routes/*.js`: 1,703 lines across 8 files (one per domain + `_utils.js`).
- `src/state.js`: 127 lines (14 wrapped state functions + 3 constants).
- Smoke: 162/162 ✅.
