# STAT Optimization Results
Generated: 2026-06-16
HEAD: 5d4216c
Smoke: 142/142 ✅

## Commits

| # | Hash | Files | Message |
|---|------|-------|---------|
| 1 | 956bf2e | smoke.js | fix: remove 12 unreachable smoke assertions (post-exit dead code) |
| 2 | 54c3fed | src/batch.js | fix: batch.js customKeywords undeclared — restores BatchPollerDO alerting |
| 3 | 6deffd1 | src/enrich.js | fix: remove dead NEEDS_BROWSER_FETCH branches in enrich.js |
| 4 | 1ad24cc | wrangler.toml | fix: remove dead STAT_KV binding — closes HANDOFF #11 |
| 5 | 4e46bbc | src/adapters.js, src/index.js, smoke.js | fix: remove 3 dead HiringCafe exports (~130 lines) |
| 6 | 545209f | src/adapters.js, src/index.js | fix: add AbortSignal.timeout to unguarded fetch calls |
| 7 | — | (skipped) | filter-order divergence (audit was wrong; see below) |
| 8 | ddda036 | scripts/_archive/* | chore: archive 8 orphan research scripts to scripts/_archive/ |
| 9 | 789b65a | src/adapters.js, src/index.js | fix: log adapter and dedup catch blocks — restores observability |
| 10 | 5d4216c | src/index.js | chore: P3 cleanup — parallel store reads, hoisted HC term filter |

9 functional commits executed of 10 planned. Commit 7 skipped because the premise was wrong (see below).

## Smoke progression

Smoke count stayed at **142** across all commits. The audit's claim of "158 executed → 146 after dedup" was incorrect: the duplicate assertions at smoke.js:303-316 sit AFTER `process.exit()` calls at lines 297/301, so they were never executed. They were dead source code, not dead test data — count never moved.

All 9 commits ran `node smoke.js` and observed `All assertions passed.` before committing.

## Issues encountered

- **Commit 1 — count never changed.** Audit said 158 executed, 12 duplicates, drop to 146. Reality: the 12 duplicate assertions were placed after `process.exit()` and never ran. Smoke stayed at 142/142. Still worth removing because the source code was misleading future readers (and the audit itself was misled by `grep -c "^assert("`).

- **Commit 5 — smoke required an update too.** Removing `export function mapHiringCafeHit` (the export keyword, not the function) broke the `mapHiringCafeHit exported / imported` smoke assertion. Replaced with a single assertion that checks `function mapHiringCafeHit` is defined — still proves the HC mapper exists without requiring the dead export/import pair.

- **Commit 7 — skipped, audit was wrong.** Re-reading `platform-do.js:221-263` and `batch.js:108-125` side-by-side, both files run the same order: ghost → browse capture → dedup → env filter → matchJob. The audit subagent claimed `platform-do.js` runs dedup BEFORE browse capture; the actual code does browse capture first. Smoke already locks the invariant in both files (lines 28-29 and 42-43 in the original smoke.js). No reorder needed, no new assertion needed. Rule 8 is intact.

- **Commit 8 — only 8 scripts archived, not 10.** The execute prompt listed `snapshot.py` and `snapshot.sh` for archival. Confirmed `snapshot.sh` is invoked by `.github/workflows/doc-snapshot.yml` and `snapshot.sh` shells out to `snapshot.py`. Both kept in active `scripts/`. The 8 truly orphan scripts moved to `scripts/_archive/`.

- **Commit 10 — stripHtml dedup deferred.** Audit P3 finding said inline HTML strippers in `enrich.js` (5 sites) should call the shared `stripHtml()` helper. On inspection, the inline versions also decode HTML entities (`&amp;`, `&nbsp;`, `&#NN;`) while `stripHtml()` only does a generic `&...;` → space replacement. Substituting calls would silently lose entity decoding. The correct fix is to upgrade the helper first (and add entity decoding), then substitute — that's bigger than a P3 quick win. Parallel store reads and hoisted filter still landed in this commit.

- **markSeenDead `.catch(() => {})` at index.js:679 left as-is.** After commit 9, `markSeenDead` logs internally and never rejects. The outer `.catch` is now defensive-only; removing it would require trusting the internal try/catch holds forever. Conservative choice was to leave the safety net.

- **seen-sweep per-URL HEAD probe catch at index.js:186 left silent.** The comment already documents the leave-as-is design (per-URL probe failures are noise; the sweep proceeds anyway). No change made.

## Remaining from audit

P2 items NOT executed (out of scope per the execute prompt):

- **handleFetch() router extraction** — explicitly deferred to a separate TYPE C session.
- **`_parseTSVLCA` removal** — explicitly retained as documented fallback.
- **Maryland UI badge** — explicitly deferred (TYPE C feature).
- **HTML stripping consolidation** — deferred from commit 10 (requires upgrading `stripHtml()` helper first; see Issues above).

P3 items NOT executed:

- **`POLL_INTERVALS.hiringcafe` verification** — audit flagged as possibly unused; not investigated this session.
- **Polite-delay constants centralization** — audit P3, not in execute prompt scope.
- **Comment drift / weak Maryland `\bmd\b` regex** — audit P3, no functional impact.
- **`STAT_KV` config-object rename in `config.js`** — audit P3 (cosmetic clarity).

## Verification

After all 9 commits:
- `node smoke.js` → 142/142 ✅
- Branch: main, HEAD: 5d4216c
- No reverted commits
- Each commit single-concern
- Each commit message describes WHY (not just WHAT)

## Net diff size

```
 .archive/*                 |  8 scripts moved (no content change)
 outbox/cc-optimization-*   |  results docs (this file + audit)
 smoke.js                   | -16 lines
 src/adapters.js            | -130 lines (dead exports + 17 timeout/log additions net)
 src/batch.js               | +9  lines (customKeywords load)
 src/enrich.js              | -21 lines (NEEDS_BROWSER_FETCH branches)
 src/index.js               | -1  line  (import) +24 lines (timeouts, logging, parallel, hoist)
 wrangler.toml              | -5  lines (STAT_KV binding)
```

Approximate total: ~140 lines deleted, ~33 lines added.
