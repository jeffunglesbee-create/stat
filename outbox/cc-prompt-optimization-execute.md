This is your second session on the STAT project. Complete the full onboarding sequence first:

## Step 0 — Governance onboarding (do this FIRST, in order)

1. Read CLAUDE.md — project rules, architecture, key files, deploy path, session protocol
2. Read STANDARDS.md — development standards, session types, adapter checklist
3. Read HANDOFF.md — current HEAD, smoke count, open items
4. Read docs/STAT-COMMITMENTS.txt — architectural constraints
5. Read docs/STAT-CLAUDE-REVIEW.txt — required context before UI changes
6. Run: node smoke.js — confirm baseline passes
7. Run: git log --oneline -10

Then read the audit: outbox/cc-optimization-audit.md

---

SESSION START · Type: B (Bug fix) + E (Cleanup) · Scope: Execute all audit findings from cc-optimization-audit.md

You are implementing every finding from the optimization audit. Work on main branch. Each fix is a separate commit. Run smoke after every commit.

## Execution order (follow exactly)

### Batch 1 — P1 fixes (do these first, one commit each)

**Commit 1: Fix smoke duplicates**
- Delete lines 303-316 in smoke.js (verbatim duplicates of 249-261)
- Run smoke — count should decrease by 12 (from 158 executed to 146)
- Commit: `fix: remove 12 duplicate smoke assertions (lines 303-316)`

**Commit 2: Fix batch.js customKeywords**
- Add `custom_keywords` load at top of alarm method in batch.js, matching the pattern in platform-do.js
- Run smoke
- Commit: `fix: batch.js customKeywords undeclared — restores BatchPollerDO alerting`

**Commit 3: Remove dead NEEDS_BROWSER_FETCH references**
- Delete the unreachable branches at enrich.js:497-498, 517, 539 that reference NEEDS_BROWSER_FETCH and fetchBrowserDescription
- Keep the fallback `return ''` path
- Run smoke
- Commit: `fix: remove dead NEEDS_BROWSER_FETCH branches in enrich.js`

**Commit 4: Remove dead STAT_KV binding**
- Delete the STAT_KV kv_namespaces block from wrangler.toml (3 lines)
- Remove any remaining STAT_KV references in comments (but keep migration history comments in store.js)
- Run smoke
- Commit: `fix: remove dead STAT_KV binding — closes HANDOFF #11`

### Batch 2 — P2 fixes (one commit each)

**Commit 5: Remove dead HiringCafe exports**
- Remove `fetchHiringCafeBR` and `fetchHcDescription` function bodies from adapters.js
- Remove `mapHiringCafeHit` from the export — keep the function itself (used internally)
- Update the import line in index.js to remove the three dead imports
- Run smoke — if any assertion breaks, the function IS used and you must revert
- Commit: `fix: remove 3 dead HiringCafe exports (~150 lines)`

**Commit 6: Add AbortSignal.timeout to adapter fetch calls**
- Add `signal: AbortSignal.timeout(8000)` to Gemini/AI calls in index.js
- Add `signal: AbortSignal.timeout(5000)` to ATS adapter fetch calls in adapters.js
- Do NOT touch enrich.js or notify.js (they already have timeouts)
- Run smoke
- Commit: `fix: add AbortSignal.timeout to 12+ unguarded fetch calls`

**Commit 7: Fix filter-order divergence in batch.js**
- Align batch.js filter order to match platform-do.js: ghost → dedup → browse-capture → env → match
- Add a smoke assertion that checks both files have the same order
- Run smoke
- Commit: `fix: align batch.js filter order with platform-do.js — Rule 8 compliance`

**Commit 8: Archive orphan scripts**
- Create `scripts/_archive/` directory
- Move these files there: analyze_hc.py, analyze_job_page.py, find_algolia.py, find_hc_api.py, hc_harvest.py, parse_browse.py, probe_hc_api.sh, probe_stat.py, snapshot.py, snapshot.sh
- Run smoke
- Commit: `chore: archive 10 orphan research scripts to scripts/_archive/`

**Commit 9: Fix silent catch blocks (top offenders only)**
- Add `console.warn('[STAT ...] ...:', e.message)` to these specific silent catches:
  - index.js: markSeenDead catch, seen-sweep catch, maybeAddOrPromoteCompany catch
  - adapters.js: top-level catch in each adapter that currently returns [] silently
- Do NOT change catches that already log
- Run smoke
- Commit: `fix: add logging to ~15 silent catch blocks — restores observability`

### Batch 3 — P3 quick wins (combine into 1-2 commits)

**Commit 10: Miscellaneous P3 cleanup**
- Replace inline HTML stripping in enrich.js with existing stripHtml() helper
- Parallelize sequential store reads in index.js `/` handler with Promise.all
- Hoist HIRINGCAFE.search_terms filter to module scope
- Run smoke
- Commit: `chore: P3 cleanup — stripHtml dedup, parallel store reads, hoisted filter`

### Do NOT do

- Do NOT extract the handleFetch() router (P2 item) — that's a separate TYPE C session
- Do NOT delete _parseTSVLCA in salary.js — keep as documented fallback
- Do NOT add the Maryland UI badge — that's a TYPE C feature
- Do NOT modify ui.html for anything other than bug fixes
- Do NOT change any test behavior — only fix duplicates and add assertions

## Rules

- One logical change per commit. Never bundle unrelated fixes.
- Run `node smoke.js` after EVERY commit. If smoke fails, fix before proceeding.
- Run `git diff --staged` before every commit — check for unintended changes.
- If any fix is more complex than expected, STOP and document why in the output file. Do not force it.

## When done

1. Write results to outbox/cc-optimization-results.md with this format:

```markdown
# STAT Optimization Results
Generated: [date]
HEAD: [final commit hash]
Smoke: [final count]

## Commits
[list each commit hash, message, and files changed]

## Smoke progression
[show smoke count after each commit]

## Issues encountered
[anything that didn't go as planned]

## Remaining from audit
[any P2/P3 items that were skipped or deferred, with reason]
```

2. Update HANDOFF.md with new state
3. git add, commit: `audit: optimization results — N commits, smoke X→Y [skip ci]`
4. git push origin main
