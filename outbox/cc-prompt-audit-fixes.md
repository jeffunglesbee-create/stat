This is a continuation session on the STAT project. Complete governance onboarding first:

## Step 0 — Governance onboarding (do this FIRST, in order)

1. Read CLAUDE.md — project rules, architecture, key files, session protocol
2. Read STANDARDS.md — development standards, session types, enforcement rules
3. Read HANDOFF.md — current HEAD, smoke count, open items
4. Read docs/STAT-COMMITMENTS.txt — architectural constraints
5. Read docs/STAT-CLAUDE-REVIEW.txt — required context before UI changes
6. Run: node smoke.js — confirm baseline passes
7. Run: git log --oneline -5 — recent history

Then read the audit that was produced last session:
8. Read outbox/cc-optimization-audit.md — the full findings you will now implement

---

SESSION START · Type: B (Bug fix) · Scope: Execute all audit findings from cc-optimization-audit.md

You are implementing the fixes identified in the optimization audit. Work through them in order. Each fix is ONE COMMIT with a clear message. Run `node smoke.js` after every commit.

## Execution order (one commit each)

### Commit 1 — Fix smoke duplicates (P1, zero risk)
- Delete lines 303-316 in smoke.js (verbatim duplicates of 249-261)
- Run smoke — count should DROP because duplicates are removed
- Update the smoke count references if needed
- Commit: `fix: remove 12 duplicate smoke assertions (303-316 copy of 249-261)`

### Commit 2 — Fix batch.js customKeywords (P1, restores functionality)
- In src/batch.js, the `alarm()` method calls `matchJob(job, customKeywords)` at line 115 but `customKeywords` is never declared or loaded
- Look at how platform-do.js loads `custom_keywords` from the store at the top of its alarm method
- Apply the same pattern in batch.js: load custom_keywords from the store before the job loop
- Commit: `fix: batch.js load customKeywords from store — was undeclared, broke all batch alerting`

### Commit 3 — Remove dead NEEDS_BROWSER_FETCH branches (P1, prevents future trap)
- In src/enrich.js, lines 497, 498, 517, 539 reference `NEEDS_BROWSER_FETCH` and `fetchBrowserDescription` which were removed 2026-06-08
- Delete those dead branches entirely — the fall-through `return ''` handles the case
- Make sure the remaining logic still makes sense after branch removal
- Commit: `fix: remove dead NEEDS_BROWSER_FETCH branches in enrich.js (deleted 2026-06-08)`

### Commit 4 — Remove dead STAT_KV binding (P1, closes #11)
- Delete the STAT_KV kv_namespaces block from wrangler.toml (3 lines)
- Keep the KV namespace in Cloudflare for rollback safety — just remove the binding
- Commit: `fix: remove dead STAT_KV binding from wrangler.toml — closes #11`

### Commit 5 — Remove dead HiringCafe exports (P2)
- In src/adapters.js: delete `fetchHiringCafeBR` (lines ~707-789) and `fetchHcDescription` (lines ~866-881)
- In src/adapters.js: remove `export` from `mapHiringCafeHit` (used internally only)
- In src/index.js: remove `fetchHiringCafeBR`, `fetchHcDescription`, `mapHiringCafeHit` from the import line
- Commit: `fix: remove 3 dead HiringCafe exports — fetchHiringCafeBR, fetchHcDescription, mapHiringCafeHit import`

### Commit 6 — Add AbortSignal.timeout to adapter fetch calls (P2)
- Add `signal: AbortSignal.timeout(8000)` to Gemini/AI calls in index.js
- Add `signal: AbortSignal.timeout(5000)` to ATS adapter fetch calls in adapters.js (Greenhouse, Lever, Ashby, SuccessFactors, Oracle, Infor, SelectMinds)
- Add `signal: AbortSignal.timeout(15000)` to diagnostic/probe endpoints in index.js
- Do NOT add timeouts to fetch calls that already have AbortController patterns
- Commit: `fix: add AbortSignal.timeout to 12+ unguarded fetch calls — prevents alarm hang`

### Commit 7 — Fix batch.js / platform-do.js filter-order divergence (P2)
- Read both batch.js and platform-do.js alarm methods side by side
- Align batch.js to match platform-do.js filter order: ghost → dedup → browse-capture → env → match
- Add a smoke assertion that verifies the order is consistent (check for a sentinel pattern in both files)
- Commit: `fix: align batch.js filter order with platform-do.js — ghost→dedup→browse→env→match`

### Commit 8 — Archive unreferenced scripts (P2)
- Create `scripts/_archive/` directory
- Move these files there: analyze_hc.py, analyze_job_page.py, find_algolia.py, find_hc_api.py, hc_harvest.py, parse_browse.py, probe_hc_api.sh, probe_stat.py
- Do NOT move: apply-agent.py, setup-apply.sh, lca-parse.js, snapshot.sh, parse_logs.py, parse_stat_status.py, parse_wd_api.py, parse_workday_probe.py
- Commit: `chore: archive 8 unreferenced research scripts to scripts/_archive/`

### Commit 9 — Extract parseJsonBody helper (P2)
- In src/index.js, there are 8+ duplicate `let body; try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }` blocks
- Create a helper at the top of the file: `async function parseBody(request) { try { return await request.json(); } catch { return null; } }`
- Replace each duplicate block with: `const body = await parseBody(request); if (!body) return json({ error: 'Invalid JSON' }, 400);`
- Commit: `refactor: extract parseBody helper — replaces 8 duplicate try/catch blocks in index.js`

## Rules for this session

- ONE concern per commit. Do not bundle changes.
- Run `node smoke.js` after EVERY commit. If smoke fails, fix before moving on.
- Do not modify any file not listed in the commit description.
- If a change breaks something unexpected, STOP. Write what happened to outbox/cc-blocked.md and commit that instead.
- Push to MAIN, not a branch. Use: `git push origin main`
- After all commits: update HANDOFF.md with the new HEAD, smoke count, and what was done.

## When done

1. Run final `node smoke.js` and record the count
2. Update HANDOFF.md
3. Commit: `docs: HANDOFF.md — S15 audit fixes complete`
4. Push to main
5. Report: list each commit hash and what it did
