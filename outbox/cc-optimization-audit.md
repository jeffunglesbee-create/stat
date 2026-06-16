# STAT Optimization Audit
Generated: 2026-06-16
HEAD: ebfbb6a
Smoke: 142/142 ✅ (but see P1-1 — actual unique assertion count diverges from claim)

## Summary

The STAT codebase is broadly healthy — well-commented architecture, clear pipeline contract, centralized response helper, generally appropriate error reporting. However, three latent runtime bugs are silently masked by outer try/catch blocks: (1) `batch.js` references an undeclared `customKeywords` (line 115), causing the BatchPollerDO alert pipeline to throw on every job; (2) `enrich.js` references a removed-but-not-deleted `NEEDS_BROWSER_FETCH` symbol at three sites (lines 497, 517, 539), guarded only by short-circuit evaluation; (3) smoke.js has 12 duplicate assertions (lines 304–316 copy 249–261 verbatim), inflating the claimed count. Beyond those, the biggest cleanup wins are removing the dead STAT_KV binding, deleting 3 dead exports from `adapters.js`, archiving ~7 unreferenced research scripts, and adding `AbortSignal.timeout()` to a dozen fetch sites.

---

## Optimizations by Priority

### P1 — High Impact

- **batch.js references undeclared `customKeywords` — silently breaks all batch alerting** — `src/batch.js:115`
  - What: `matchJob(job, customKeywords)` is called but `customKeywords` is never declared, imported, or loaded. `platform-do.js` loads `custom_keywords` from the store at the top of its alarm method; `batch.js` does not. The ReferenceError is caught by the outer `try { … } catch (e) { console.warn(...) }` around the per-company loop (line 94), so every batch job silently throws and falls through to nothing.
  - Evidence: `grep customKeywords src/batch.js` shows exactly one hit at line 115; no `const customKeywords` or `let customKeywords` anywhere in the file. Compare to `platform-do.js:137-140` which does the load.
  - Value: Restores BatchPollerDO alerting end-to-end. Per Rule 13 (Automation is architecture), a broken alarm loop is an architectural failure, not a feature gap.
  - Effort: S — add 4-line load at top of alarm method.
  - Risk: Low — change is additive; current code is no-op.

- **`NEEDS_BROWSER_FETCH` references undefined symbols** — `src/enrich.js:497,498,517,539`
  - What: The comment at line 39 states `NEEDS_BROWSER_FETCH removed 2026-06-08 — all ATS description paths now use plain fetch`, but four references survive in `fetchJobDescription()` and `enrichDescriptions()`. These would throw `ReferenceError` whenever a job lacks a description AND its `atsSource` is not in `NEEDS_PLAIN_FETCH` and not SuccessFactors. Currently masked because every active ATS source is either in `NEEDS_PLAIN_FETCH` or is SuccessFactors — but the branch is a trap waiting for the next ATS adapter.
  - Evidence: lines 497 (`NEEDS_BROWSER_FETCH.has(job.atsSource)`), 498 (`fetchBrowserDescription(job, env)`), 517, 539. Neither symbol is defined or imported in the file.
  - Value: Removes a latent crash path that bypasses smoke (smoke checks neither symbol).
  - Effort: S — delete the dead branches; the fall-through `return ''` at line 501 already handles "no description path".
  - Risk: Low — branches are unreachable in practice today.

- **smoke.js has 12 duplicate assertions; HANDOFF.md claims 142 but file executes 158** — `smoke.js:303-316` (verbatim duplicates of 249-261)
  - What: Lines 304-316 copy lines 249-261 word-for-word ("wrangler: R2 bucket bound as STAT_R2", "salary: R2 helper _r2Get defined", etc.). `grep -c "^assert(" smoke.js` returns 158; HANDOFF.md and the recent commit messages quote 142.
  - Evidence: `grep -n "R2 bucket bound as STAT_R2" smoke.js` → lines 249 + 304; same pattern for 250/305, 263/316, etc.
  - Value: Truth-in-counting (Rule 5b — "the label was lying"). 12 wasted checks per commit, and the inflated number disguises real coverage gaps.
  - Effort: S — delete lines 303-316.
  - Risk: None — removed assertions still exist at lines 249-261.

- **Dead KV binding `STAT_KV` in wrangler.toml** — `wrangler.toml:12-14`, carry-forward HANDOFF.md #11
  - What: Migration to StateStoreDO (store.js comment at line 7: "Migrated from STAT_KV to DO SQLite") is complete. No Worker code references `env.STAT_KV`. The binding still consumes a KV namespace ID.
  - Evidence: `grep -rn STAT_KV src/` shows only a migration comment in `index.js:1809` and `store.js:7,81` — no `env.STAT_KV` reads or writes.
  - Value: Removes a phantom binding; closes a stale HANDOFF item that has been carried 14 sessions.
  - Effort: S — delete 3 lines from wrangler.toml.
  - Risk: None — binding is unused. Recommend keeping the KV namespace itself in Cloudflare for one release in case of rollback.

### P2 — Medium Impact

- **Three dead exports in adapters.js imported by index.js but never invoked** — `src/adapters.js:648 (mapHiringCafeHit), 707 (fetchHiringCafeBR), 866 (fetchHcDescription)`
  - What: `index.js:30` imports all three. `mapHiringCafeHit` is used internally inside `adapters.js:856` — the import is unnecessary. `fetchHiringCafeBR` and `fetchHcDescription` are imported but only referenced in a documentation comment at `index.js:712`. Description fetching is done by `enrich.js fetchPlainDescription()` instead.
  - Evidence: `grep fetchHcDescription src/index.js` → only the import line and a comment; `grep fetchHiringCafeBR src/index.js` → only the import line. Comment at `adapters.js:618` already documents "BR path retained as dead code — searchState SSR is simpler and sufficient."
  - Value: Removes ~150 lines of unused code (`fetchHiringCafeBR` body lines 707-789, `fetchHcDescription` lines 866-881). Reduces bundle size and adapter surface area.
  - Effort: S — trim the import to `fetchHiringCafe` only; delete the two dead exported functions.
  - Risk: Low — confirmed unused. The Drive-archived docs still reference them, but those are historical artifacts.

- **Silent catch blocks on critical adapter and dedup paths violate Rule 9** — multiple
  - What: Rule 9 requires logging on any catch that could hide a bug producing wrong-but-plausible results. Notable offenders:
    - `index.js:124` `markSeenDead` swallows store-write failure silently — a dead job stays "live" in the seen-set.
    - `index.js:184` seen-sweep liveness HEAD throws silently — resurrection opportunity lost without trace.
    - `index.js:675, 1026` `.catch(() => {})` on `markSeenDead` and `maybeAddOrPromoteCompany` — same class of bug.
    - `adapters.js:102, 132, 161, 338, 440, 599, 720, 756, 787, 1071, 1208, 1219` — adapter catch blocks return `[]` with no log, so any ATS API contract change fails invisibly until "no new jobs from greenhouse for 3 days" is noticed manually.
    - `batch.js:81-85` does log (good), but the per-company `catch (e)` at line 94 logs only at console.warn — the broken `customKeywords` ReferenceError above lives here.
  - Evidence: `grep -nE '} catch \{|\.catch\(\(\) =>' src/*.js` — substantial count.
  - Value: Restores observability. Many of these surface as "the system seemed fine" diagnosis errors (Rule 5b violation).
  - Effort: M — needs case-by-case judgment on what to log. Pattern: `catch (e) { console.warn('[STAT <context>] <op> failed:', e.message); return <fallback>; }`.
  - Risk: Low — logging is additive.

- **Fetch calls without `AbortSignal.timeout()` — 12+ sites** — multiple files
  - What: `checkJobLiveness()` (notify.js:224) and `fetchPlainDescription` (enrich.js:172) use `AbortSignal.timeout(4000)` correctly; the pattern is not applied consistently. Sites without timeouts that can hang the alarm:
    - `index.js:278, 389` — Gemini calls (keyword generation, profile extraction)
    - `index.js:917, 1490, 1521` — jobhive CSV fetches (have Range headers, no timeout)
    - `index.js:1706, 2258, 2463, 2580` — diagnostic endpoints
    - `adapters.js:82 (Greenhouse), 113 (Lever), 143 (Ashby), 373 (SF), 908 (Oracle), 1007 (Infor), 1143 (SelectMinds)` — primary ATS adapters
  - Value: Prevents alarm wall-clock exhaustion (30s) on a slow ATS. Currently a slow Workday tenant can take all of platform-do.js's budget.
  - Effort: S-M — wrap each in `AbortSignal.timeout(8000)` for Gemini, `5000` for ATS adapters, `15000` for diagnostics.
  - Risk: Low — timeouts only abort; failure paths already exist.

- **Filter-order divergence between batch.js and platform-do.js violates Rule 8** — `src/batch.js:99-115` vs `src/platform-do.js`
  - What: Rule 8 mandates identical filter order across all three job-processing paths. `batch.js` runs ghost → browse-capture → dedup → env → match. `platform-do.js` runs ghost → dedup → browse-capture → env → match. The dedup/browse swap means jobs already in the global seen-set still get re-captured to Browse in batch but not in platform-do.
  - Evidence: `batch.js:104-115` puts `passesEnvFilter`/`unmatchedJobs.push` BEFORE `seenIds.has(job.id)`. `platform-do.js` does it AFTER.
  - Value: Restores invariant the smoke gate is supposed to enforce. Per Rule 14 ("Browse and Matches are not independent stores"), divergence here corrupts both.
  - Effort: S — re-order ~4 lines in one file.
  - Risk: Low — but smoke needs a new assertion to lock the order in both files (currently only platform-do.js is asserted; smoke.js:264-275 only checks the platform-do side).

- **Unreferenced research/probe scripts** — `scripts/`
  - What: Of 17 scripts, the following are not invoked by any workflow, smoke assertion, or CLAUDE.md/HANDOFF.md instruction: `analyze_hc.py`, `analyze_job_page.py`, `find_algolia.py`, `find_hc_api.py`, `hc_harvest.py`, `parse_browse.py`, `probe_hc_api.sh`, `probe_stat.py`, `snapshot.py` (called only by snapshot.sh in older versions — `bash scripts/snapshot.sh` no longer wraps it).
  - Evidence: `grep -rE 'scripts/' .github/workflows/ docs/ *.md` shows ~9 named scripts; the remainder appear nowhere.
  - Value: Removes ~17KB of orphan code. Some are clearly artifacts of HiringCafe Algolia/API discovery sessions that are now complete.
  - Effort: S — delete or move to `scripts/_archive/`.
  - Risk: Low — these are read-only probes, not part of any active path. If the user keeps them as historical reference, move to `_archive/` instead of delete.

- **`handleFetch()` in index.js is 1600+ lines of inline routing** — `src/index.js:1082-2700`
  - What: One monolithic handler with ~40 `if (url.pathname === '/x' && request.method === 'Y')` branches. Comments scroll past faster than the eye can follow new endpoints.
  - Value: Easier code review, fewer merge conflicts as endpoints are added.
  - Effort: M — extract by domain (`handleSalary`, `handleProfile`, `handleDiagnostics`, `handlePlatform`) without changing semantics.
  - Risk: Medium — touches the largest, most-deployed file. Recommend doing this in its own TYPE C session, not bundled with the bug fixes above.

### P3 — Low Impact / Nice-to-have

- **HTML stripping boilerplate duplicated 5+ times in enrich.js** — `src/enrich.js:188-198, 295-301, 342-347, 425-430, 444-452`
  - What: A centralized `stripHtml()` exists at line 565, but five other call sites inline the same regex chain. Trivial duplication; the centralized helper is the obvious consumer.
  - Effort: S. Risk: minimal — but verify entity-decoding parity before swapping.

- **Sequential awaits on independent store reads in `/` handler** — `src/index.js:1112-1115`
  - What: 4 independent `loadXxx(env)` calls run sequentially when `Promise.all([...])` would parallelize. Gain ~100-300ms per `/` open. Same shape at lines ~2166.
  - Effort: S. Risk: none.

- **Dead-but-defined `_parseTSVLCA` in salary.js** — `src/salary.js:785`
  - What: Only the definition exists; no internal or external caller. The XLSX path covers all current LCA quarters.
  - Effort: S. Risk: keep if you want a TSV fallback for DOL format changes — but mark with a comment so the next reader doesn't assume it's active.

- **Maryland scoring never surfaces a UI badge** — `src/maryland.js` exported and called everywhere, but `ui.html renderMatchCard()` never reads `job.mdScore`/`job.mdSignals`.
  - What: The pipeline produces data the UI doesn't show, or alerts use it server-side only. Either land the badge (TYPE C) or document the server-only intent (Rule 15: UI labels must reflect live state — corollary: server signals should be UI-visible or documented as alert-only).
  - Effort: S — add `<span class="md-badge">MD</span>` conditional in renderMatchCard.

- **`HIRINGCAFE.search_terms` filtered down twice on each cron tick** — `src/index.js:624-629`
  - What: `HIRINGCAFE.search_terms.filter(...).filter` runs every cron tick to recompute the same Epic-term subset. Hoist to module scope.
  - Effort: S — single-line const.

- **Polite-delay constants scattered** — `src/adapters.js:244 (300ms), 590 (150ms)`, `index.js:692 (400ms), 1036 (500ms)`
  - What: Magic numbers across adapters/index. Move to `config.js POLITE_DELAY_MS` block for one source of truth.
  - Effort: S. Risk: none.

- **`STAT_KV` config object in `config.js`** — `src/config.js KV.max_seen` is still used by `saveSeenIds` (index.js:111). Confirm the config key is renamed or commented as referring to the in-memory map cap, not the KV namespace — otherwise a future reader will conflate it with the dead binding.

---

## Dead Code Inventory

| Item | Location | Status |
|---|---|---|
| `fetchHiringCafeBR` (export) | `adapters.js:707-789` | Imported by index.js, never invoked. Delete. |
| `fetchHcDescription` (export) | `adapters.js:866-881` | Imported by index.js, never invoked. Delete. |
| `mapHiringCafeHit` (export) | `adapters.js:648` | Used internally — drop the export keyword and the index.js import. |
| `NEEDS_BROWSER_FETCH` (symbol) | `enrich.js:497,517` | Undefined reference left after removal. Delete branches. |
| `fetchBrowserDescription` (call) | `enrich.js:498,539` | Undefined function called in unreachable branch. Delete. |
| `_parseTSVLCA` method | `salary.js:785-823` | No caller. Keep with comment if it's a documented fallback, else delete. |
| `STAT_KV` binding | `wrangler.toml:12-14` | Migration to StateStoreDO complete. Delete. |
| Duplicate smoke assertions | `smoke.js:303-316` | Verbatim copy of 249-261. Delete. |
| Orphan scripts (research artifacts) | `scripts/analyze_hc.py, analyze_job_page.py, find_algolia.py, find_hc_api.py, hc_harvest.py, parse_browse.py, probe_hc_api.sh, probe_stat.py` | Not referenced by any workflow or doc. Archive to `scripts/_archive/` or delete. |
| Stale comment: "BR path retained as dead code" | `index.js:618` | Comment is fine; the actual dead BR code is in adapters.js (see above). |

---

## Metrics

- **Total lines audited** (src/ + smoke.js): 10,992
- **Largest files**:
  1. `src/index.js` — 2,785 lines
  2. `src/ui.html` — 2,131 lines
  3. `src/adapters.js` — 1,242 lines
  4. `src/salary.js` — 992 lines
  5. `src/config.js` — 853 lines
- **`fetch()` calls without explicit timeout**: 12+ (index.js: 9, adapters.js: 7, ui.html: separate concern)
- **Silent catch blocks (`catch {}` or `.catch(() => {})` with no logging)**: ~20 across src/
- **`console.log/warn/error` in production**: 41 in index.js, 4 in notify.js, ~8 in adapters.js, ~6 in salary.js, ~2 each elsewhere. All `[STAT …]` prefixed — appropriate.
- **Smoke assertions**: 158 executed, but 12 are exact duplicates (lines 303-316 copy 249-261). Effective unique count: 146.
- **Dead imports**: 3 (`fetchHiringCafeBR`, `fetchHcDescription`, `mapHiringCafeHit` at `index.js:30`).
- **Undefined-symbol references masked by short-circuit / try-catch**: 2 (`customKeywords` in batch.js, `NEEDS_BROWSER_FETCH`/`fetchBrowserDescription` in enrich.js).

---

## Caveats for the reviewer

- This audit is analysis only — no code changed.
- Items in P3 are quality-of-life; ignore freely.
- The three P1 items are independent bug fixes — each one would be a clean TYPE B commit.
- Recommend addressing them in this order: smoke-duplicate-removal (zero risk) → batch.js customKeywords (restores functionality) → enrich.js dead branches (prevents future trap) → STAT_KV cleanup (closes #11).
- The `handleFetch()` extraction (P2) is the only finding large enough to warrant its own session.
