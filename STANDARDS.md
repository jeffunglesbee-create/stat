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

## Rule 7 — Manual operation buttons are escape hatches, not features

Every button in the Operations sidebar (Bootstrap watchers, Backfill
Browse tab, Refresh status, HiringCafe scan now) exists because the
automated path was incomplete or broken. They are escape hatches.

Before shipping any feature that requires a manual button to work:
ask whether the automated path makes that button unnecessary.
If the button is still needed after the automated path is correct,
document why in a comment on the button's handler.

A button that does nothing when clicked is not an escape hatch —
it is a broken feature. Treat it as a TYPE B bug, not a UI gap.

---

## Rule 8 — Endpoint logic must match alarm loop logic exactly

Three code paths process jobs: platform-do.js alarm loop, batch.js
alarm loop, and index.js one-shot endpoints (/backfill-browse, /trigger).

All three must apply filters in identical order and with identical logic.
Divergence creates inconsistent behavior that is invisible until a user
compares outputs manually.

Canonical filter order (do not vary):
  1. Ghost filter (suppress too-old jobs)
  2. Browse capture (env filter + !matchJob, before dedup)
  3. Dedup (alert path only)
  4. Env filter (alert path)
  5. Keyword match (alert path)
  6. Liveness check (alert path)

When adding a filter step, add it to ALL THREE paths in the same
commit. Smoke assertions must verify order consistency.

---

## Rule 9 — Silent catch blocks require justification

`catch {}` and `catch { return fallback; }` swallow errors silently.
This is acceptable ONLY for truly non-critical paths (e.g. browser
cleanup, cosmetic UI state). For any path that affects data
correctness — store reads, store writes, job processing — silent
catches hide bugs that persist across sessions.

Pattern for critical paths:
```js
} catch (e) {
  console.warn('[STAT context] operation failed:', e.message);
  // then return fallback or rethrow as appropriate
}
```

Before adding a silent catch: ask whether a failure here would
produce a wrong result that looks correct. If yes, it must log.

---

## Rule 10 — UI polling intervals must cover all data surfaces

`loadStatus()` runs on init and every 30s. This covers the system
status panel. It does not auto-refresh Matches, Browse, or Activity Log.

Every tab that displays live data must either:
  (a) auto-refresh on a timer while active, OR
  (b) load fresh data on tab activation (current approach for
      Matches and Browse), OR
  (c) have a documented reason why stale data is acceptable

If a tab loads on activation, that load must be verified in smoke.js.
If a tab does not load on activation, the reason must be in a comment
on the tab-switch handler.

Corollary: a Refresh button is only acceptable as a *secondary*
control on top of an automated path. It must never be the only path.

---

## Rule 11 — One-shot endpoints must be marked stale after the automated path ships

/backfill-browse existed because Browse capture was broken in the
alarm loop. Now that the alarm loop is fixed, /backfill-browse is
a recovery tool only — useful if the store is empty, not needed
for normal operation.

When a one-shot endpoint was created to compensate for a broken
automated path, and that path is subsequently fixed:
  1. Add a comment to the endpoint marking it as "recovery only"
  2. Update HANDOFF.md noting the endpoint is no longer primary
  3. Do NOT remove it — it remains a valid recovery escape hatch

This prevents future sessions from treating a recovery tool as the
intended automation and building on top of it.

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
