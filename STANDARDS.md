# STAT Development Standards

---

## Session start checklist

```
0. Read HANDOFF.md in repo root — state, open items, last HEAD
1. Read STAT-CURRENT-STATE.txt in docs/ — live features, known gaps
2. Declare: "SESSION START · Type: [B/C/D] · Scope: [one sentence]"
3. git pull
4. node smoke.js src/  ← must pass before touching anything
5. TYPE B: write diagnosis (root cause + failure path) before first code change
6. TYPE C: write spec (inputs / outputs / call sites) before first code change
```

---

## Session types — mutually exclusive

| Type | Scope | Commit prefix |
|------|-------|---------------|
| **B** Bug fix | One root cause, diagnosed first | `fix: [root cause]` |
| **C** Feature | One feature, spec written first | `feat: [name]` |
| **D** Audit | Gap analysis only — fixes become TYPE B | `audit: [area]` |

---

## Rule 1 — One concern per commit

`"fix: Browse capture before dedup gate"` ✓
`"fix Browse + add feature + update config"` ✗

---

## Rule 2 — Smoke gate blocks every commit

`smoke.js` runs on every commit via pre-commit hook and CI.
Any failure blocks the commit. No `--no-verify` shortcuts.

Add a named assertion for every significant wiring point:
- Correct function call order (e.g. capture before dedup)
- Endpoint present in index.js
- UI function called on tab activation
- Store read/write functions exported and imported where expected

---

## Rule 3 — Verify in browser, not just CI

CI passing means the build succeeded. It does not mean the feature works.

Before declaring any UI feature complete:
- Verify end-to-end in the browser, OR
- Add a smoke assertion that would catch the specific failure mode

Mark browser-confirmed features with a comment:
```js
// browser-confirmed: YYYY-MM-DD
```

---

## Rule 4 — HANDOFF.md at every session end

Written to repo root. Committed with code. Contains:
- HEAD SHA
- Smoke state (pass/fail + count)
- What was fixed or shipped this session
- Open items carried forward
- Any known broken behavior

Next session reads it before touching anything.

---

## Rule 5 — DO NOT ASSUME

Every displayed value traces to a verifiable source.
Every alert traces to a job confirmed live at the ATS at alert time.
Nothing fabricated, nothing guessed.

Applies equally to back-end code: never assume a function is called
in the right order, assume a store is populated, or assume a UI event
is wired. Verify in the code. If uncertain, add a smoke assertion.

---

## Rule 6 — Dedup is for alerts only

The seen-ID set (seenIds / globalSeen) gates **alert dedup**.
It must never gate Browse capture, salary enrichment, or any
read-only surface. These surfaces are explicitly "things you
might have missed" — seen status is irrelevant to them.

Pattern: capture for read-only surfaces BEFORE the dedup continue.
Alert path runs AFTER dedup as always.

---

## Smoke gate — critical invariants to assert

```
src/platform-do.js:
  - unmatchedJobs.push() appears before seenIds.has() check
  - saveUnmatchedJobs() called after alarm loop

src/batch.js:
  - unmatchedJobs.push() appears before seenIds.has() check
  - saveUnmatchedJobs() called after loop

src/index.js:
  - pathname === '/browse' endpoint present
  - loadUnmatchedJobs imported and called in /browse handler

src/ui.html:
  - loadBrowse() defined
  - loadBrowse() called in tab-switch handler (not only on btn-refresh click)
  - btn-refresh-browse onclick = loadBrowse
```

---

## Session end checklist

```
1. node smoke.js src/  ← must pass
2. Verify changed feature in browser (or add smoke assertion)
3. Commit with correct prefix and single-concern message
4. Update HANDOFF.md — HEAD, smoke state, open items
5. git push
6. Update STAT-CURRENT-STATE.txt if any capability changed
```
