# STAT — Viewport auto-trigger + Workday warn logging (2026-06-23)

**Status:** ⚠️ **Partial — Task 3 shipped, Task 2 deferred** (smoke gate
contradicts the requested viewport change).
**Smoke:** **213/213 ✅** after deferring Task 2.

## Quick summary

| Task | Status | Notes |
|---|---|---|
| 1 — Discover workflow filenames | ✅ | named below |
| 2 — Add `workflow_run` trigger + `if:` to viewport workflows | ⏸ deferred | smoke locks them as dispatch-only; constraint forbids smoke edits |
| 3 — Add warn log in `fetchWorkday()` | ✅ shipped | `src/adapters.js` (not `src/index.js`) |
| 4 — `npm test` | ✅ 213/213 | after reverting Task 2 |
| 5 — Outbox manifest | ✅ | this file |
| Deploy via CI push | ✅ | `src/**` change triggers `deploy.yml` on push |

## Task 1 — workflow names (discovery is preserved even though Task 2 deferred)

| Role | Filename | Exact `name:` |
|---|---|---|
| Deploy | `.github/workflows/deploy.yml` | **`Deploy STAT worker`** |
| Viewport (iOS) | `.github/workflows/ios-safari-audit.yml` | `iOS Safari Viewport Audit` |
| Viewport (Android) | `.github/workflows/android-chrome-audit.yml` | `Android Chrome Viewport Audit` |

Exactly two viewport workflows.

## Task 2 — deferred (smoke conflict)

The exact change I would have made to **both** viewport files:

```yaml
# Before
on: workflow_dispatch

jobs:
  <ios-safari | android-chrome>:
    runs-on: <macos-latest | ubuntu-latest>

# After
on:
  workflow_dispatch:
  workflow_run:
    workflows: ["Deploy STAT worker"]
    types: [completed]
    branches: [main]

jobs:
  <ios-safari | android-chrome>:
    if: >
      github.event_name == 'workflow_dispatch' ||
      github.event.workflow_run.conclusion == 'success'
    runs-on: <macos-latest | ubuntu-latest>
```

**Why deferred:** `smoke.js:152` and `smoke.js:170` are pre-existing
assertions named `cross-engine: <ios|android> workflow is workflow_dispatch only`.
They check:

```js
return wf.includes('on: workflow_dispatch') && !wf.includes('on:\n  push');
```

Both fail with the proposed change in two ways:

1. The literal string `on: workflow_dispatch` (single-line scalar) is
   replaced with `on:\n  workflow_dispatch:` (block form) — the
   `wf.includes(...)` short-string check no longer matches.
2. The assertion *label* says "workflow_dispatch only", which is the
   exact invariant the new `workflow_run` trigger breaks. Even if the
   literal-string check were rewritten, the assertion's intent
   contradicts Task 2.

The session constraint says **"Do not modify ... smoke tests, or any
other file"**. The `deploy.yml` Smoke-gate step runs the same assertions
pre-deploy, so pushing the viewport edits would fail the deploy gate too.

Per Task 4 ("If tests fail, stop and report") + the constraint, I
reverted both viewport workflow files to their original
`on: workflow_dispatch` form. The viewport workflows on `main` remain
exactly as they were before this session.

## Task 3 — `fetchWorkday()` warn log (SHIPPED)

**Path discrepancy with prompt.** Prompt named `src/index.js`; the
`fetchWorkday` function lives in `src/adapters.js` (line 208) — the
codebase splits the adapters out of the entry module. Same situation as
the prior wd5-unblock task. Intent unambiguous; edited the file that
actually contains the function.

**Before** (`src/adapters.js:253`):
```js
      if (!res.ok) break;
```

**After**:
```js
      if (!res.ok) {
        console.warn(`[STAT Workday] ${company.name}: HTTP ${res.status} on page ${page} — skipped`);
        break;
      }
```

Wraps the existing `break` only — no fetch-behavior change, no
control-flow change. The warn will surface in `wrangler tail` and the
CF Workers logs, making per-tenant 422 / 5xx / WAF responses visible
instead of indistinguishable from "tenant has zero jobs".

## Task 4 — smoke

```
$ node smoke.js
STAT smoke: 213/213 passed
All assertions passed.
```

## Recommended next step for the viewport auto-trigger (your call)

The viewport auto-trigger is a clean, useful change blocked only by the
two smoke assertions. Three resolution paths, in order of recommended:

1. **Update the two smoke assertions to assert the new behavior** —
   e.g. replace each with:
   ```js
   return wf.includes('workflows: ["Deploy STAT worker"]') &&
          wf.includes('workflow_run');
   ```
   Then re-apply the Task 2 diff and ship. This is the minimal change
   that gives you auto-firing viewport tests while keeping a working
   smoke gate. The constraint forbade me from doing this in-session;
   it doesn't bind a follow-up.

2. **Drop the auto-trigger plan** if the dispatch-only invariant is
   intentional (e.g., real-device CI minutes are expensive — the
   workflow header comment says exactly that). The current shipping
   set is the warn log alone, which has independent value.

3. **Bypass smoke for this one commit** — not recommended; deploy.yml's
   `Smoke gate` step would still fail and block the deploy.

## Deploy

The `src/adapters.js` change pushes to `main`, which triggers
`deploy.yml` on the `paths: src/**` filter. Deploy is expected to run
and succeed (smoke passes the gate; no other behavioral change in the
adapter).
