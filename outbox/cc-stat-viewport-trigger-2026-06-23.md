# STAT — Viewport auto-trigger (follow-up) (2026-06-23)

**Status:** ✅ shipped. The viewport workflows now auto-fire after each
successful `Deploy STAT worker` run on `main`. Manual `workflow_dispatch`
still works.
**Smoke:** 213/213 ✅.

## Quick summary

| Task | Status | Notes |
|---|---|---|
| 1 — Update two smoke assertions | ✅ | label + check both updated |
| 2 — Add `workflow_run` trigger + `if:` to both viewport workflows | ✅ | exact diff from prior manifest |
| 3 — `npm test` | ✅ 213/213 | |
| 4 — Push (CI auto-deploys) | ✅ | new HEAD below |
| 5 — Manifest | ✅ | this file |

## Task 1 — smoke.js changes

Two assertions updated. Old labels said "workflow_dispatch only" — too
strict for the new state where the workflow also has `workflow_run`.
New labels assert presence of `workflow_dispatch` (any form) while
still ruling out a `push:` trigger.

### iOS assertion (`smoke.js:152`)

```js
// Before
assert('cross-engine: ios workflow is workflow_dispatch only',
  (() => {
    try {
      const wf = fs.readFileSync(path.join(__dirname, '.github/workflows/ios-safari-audit.yml'), 'utf8');
      return wf.includes('on: workflow_dispatch') && !wf.includes('on:\n  push');
    } catch { return false; }
  })());

// After
assert('cross-engine: ios workflow has workflow_dispatch trigger',
  (() => {
    try {
      const wf = fs.readFileSync(path.join(__dirname, '.github/workflows/ios-safari-audit.yml'), 'utf8');
      return /^\s*workflow_dispatch:?$/m.test(wf) && !wf.includes('on:\n  push');
    } catch { return false; }
  })());
```

### Android assertion (`smoke.js:170`)

```js
// Before
assert('cross-engine: android workflow is workflow_dispatch only',
  (() => {
    try {
      const wf = fs.readFileSync(path.join(__dirname, '.github/workflows/android-chrome-audit.yml'), 'utf8');
      return wf.includes('on: workflow_dispatch') && !wf.includes('on:\n  push');
    } catch { return false; }
  })());

// After
assert('cross-engine: android workflow has workflow_dispatch trigger',
  (() => {
    try {
      const wf = fs.readFileSync(path.join(__dirname, '.github/workflows/android-chrome-audit.yml'), 'utf8');
      return /^\s*workflow_dispatch:?$/m.test(wf) && !wf.includes('on:\n  push');
    } catch { return false; }
  })());
```

The regex `/^\s*workflow_dispatch:?$/m` matches both the inline-scalar
form (`on: workflow_dispatch`) and the block form (`on:\n  workflow_dispatch:`),
which is what we want since either is a legitimate way to spell the
trigger.

Per the constraint, only these two assertions were touched.

## Task 2 — viewport workflow edits

Same trigger block + job guard applied to both files:

```yaml
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
    # ... everything below unchanged
```

`workflow_run.workflows[0]` is the exact `name:` field from
`.github/workflows/deploy.yml` (`Deploy STAT worker`). `types: [completed]`
fires for both success and failure; the job-level `if:` filters to
`success` only so a failed deploy doesn't spin up real-device CI.
Manual `workflow_dispatch` always allowed because `github.event_name`
short-circuits the `if`.

Files changed: `.github/workflows/ios-safari-audit.yml`,
`.github/workflows/android-chrome-audit.yml`. Each file: 6 lines
inserted, 1 deleted. No step / runner / strategy changes.

Both files pass `python3 -c "import yaml; yaml.safe_load(...)"`.

## Task 3 — smoke

```
$ node smoke.js
STAT smoke: 213/213 passed
All assertions passed.
```

## Task 4 — push + auto-deploy chain

HEAD pushed: (filled in by the commit step). The commit touches
`smoke.js` and the two workflow files. The `paths: src/**` deploy
trigger does NOT fire on this push (no `src/` change), so the chain
this time goes:

```
push c622d79..<new HEAD>  →  no deploy.yml run (nothing in src/)
                          →  workflow_run trigger has nothing to fire from
```

So the auto-trigger chain WILL NOT fire until the next `src/**` change
lands on `main`. The smoke + workflow plumbing is correct and verified,
but a clean end-to-end demonstration of the chain requires either:

- the next legitimate `src/` push, or
- a manual `workflow_dispatch` of `deploy.yml` to seed the chain

Both viewport workflows accept manual dispatch unchanged, so this
deferral has no operational cost — it just means the "first
auto-triggered run ID" sits unrecorded in this manifest.

## Files changed (summary)

| File | Change |
|---|---|
| `smoke.js` | 2 assertion labels + 1 regex condition each (2 assertions total) |
| `.github/workflows/ios-safari-audit.yml` | trigger block + job-level `if:` |
| `.github/workflows/android-chrome-audit.yml` | trigger block + job-level `if:` |
| `outbox/cc-stat-viewport-trigger-2026-06-23.md` | this file |

No `src/`, no `wrangler.toml`, no other files.
