Complete the full onboarding sequence first:

## Step 0 — Governance onboarding (do this FIRST, in order)

1. Read CLAUDE.md — project rules, architecture, key files, deploy path, session protocol
2. Read STANDARDS.md — development standards, session types, adapter checklist
3. Read HANDOFF.md — current HEAD, smoke count, open items
4. Read docs/STAT-COMMITMENTS.txt — architectural constraints
5. Run: node smoke.js — confirm baseline passes
6. Run: git log --oneline -10
7. Read outbox/cc-optimization-audit.md — the audit that identified these items
8. Read outbox/cc-optimization-results.md — the prior session's execution results

---

SESSION START · Type: C (Feature) + E (Refactor) · Scope: handleFetch router extraction + stripHtml consolidation

Two refactors this session. Both are structure-only — zero behavior change. Smoke must pass after every commit. Work on main branch.

---

## Task 1: stripHtml consolidation (do this FIRST — smaller, lower risk)

### Context

There are 5 inline HTML-stripping chains in enrich.js (lines ~192, ~225, ~296, ~343, ~401) that duplicate the `stripHtml()` helper (line ~545) but add extra behavior the helper lacks. The prior CC session deferred this because the helper doesn't handle `<style>/<script>` removal or named entity decoding.

### Step 1A: Upgrade the stripHtml helper

Replace the existing `stripHtml()` function in enrich.js with this upgraded version that handles everything the inline sites do:

```js
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')   // remove script blocks
    .replace(/<style[\s\S]*?<\/style>/gi, '')      // remove style blocks
    .replace(/<[^>]+>/g, ' ')                      // strip remaining tags
    .replace(/&nbsp;/g, ' ')                       // named entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))  // numeric entities
    .replace(/&#?[a-zA-Z0-9]+;/g, ' ')            // remaining unknown entities
    .replace(/\\r\\n/g, ' ')                       // literal escape sequences (SF XML)
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
```

### Step 1B: Add smoke assertion BEFORE substituting

Add a smoke assertion that tests the upgraded stripHtml behavior. Something like:

```js
assert('enrich: stripHtml handles script/style/entities',
  read('enrich.js').includes("/<script[\\s\\S]*?<\\/script>/gi")
  && read('enrich.js').includes("&amp;/g")
  && read('enrich.js').includes("String.fromCharCode"));
```

Run smoke. Commit: `refactor: upgrade stripHtml helper — script/style removal + entity decoding`

### Step 1C: Replace inline chains

Now replace each of the 5 inline HTML-stripping chains with a call to `stripHtml()`. For each site:
1. Read the inline chain carefully
2. Confirm the upgraded `stripHtml()` covers every operation in the chain
3. If the inline chain does something `stripHtml()` doesn't, do NOT replace it — document why
4. Replace with `stripHtml(...)` call

After ALL 5 replacements, run smoke. Commit: `refactor: replace 5 inline HTML strippers with stripHtml() helper`

---

## Task 2: handleFetch router extraction (do this SECOND — larger, more risk)

### Context

`src/index.js` has a ~1,600-line `handleFetch()` function with 37 `if (url.pathname === ...)` branches. This session extracts routes into domain-specific files without changing ANY behavior.

### Architecture

Create route handler files in `src/routes/`:

```
src/routes/ui.js          — /ui, /
src/routes/jobs.js         — /jobs, /browse, /backfill-browse, /feedback, /feedback/summary, /dispatch-apply
src/routes/companies.js    — /companies (GET+POST), /detect-ats, /bootstrap, /harvest
src/routes/salary.js       — /salary-status, /salary-refresh, /salary-load-r2
src/routes/profile.js      — /profile (GET+POST+DELETE), /score-job, /review, /extract-profile, /regenerate-keywords, /learning
src/routes/operations.js   — /trigger, /jobhive-scan, /jobhive-sample, /jobhive-manifest, /batch-status, /logs, /reset-seen, /reset-all
src/routes/diagnostics.js  — /workday-probe, /plain-fetch-test, /br-test, /html-probe, /hc-probe
```

### Rules for extraction

1. **Zero behavior change.** Every route must produce identical responses before and after.
2. **Each route file exports a single handler function** that takes `(request, url, env)` and returns a `Response` or `null` (null = not my route, try next).
3. **The `json()` helper** must be available to all route files. Either export it from index.js or move it to a shared utils file.
4. **Imports stay where they're used.** If only salary routes use salary.js imports, those imports go in routes/salary.js, not index.js.
5. **index.js becomes a thin dispatcher:**

```js
import { handleUI } from './routes/ui.js';
import { handleJobs } from './routes/jobs.js';
import { handleCompanies } from './routes/companies.js';
import { handleSalary } from './routes/salary.js';
import { handleProfile } from './routes/profile.js';
import { handleOperations } from './routes/operations.js';
import { handleDiagnostics } from './routes/diagnostics.js';

// In handleFetch:
const handlers = [handleUI, handleJobs, handleCompanies, handleSalary, handleProfile, handleOperations, handleDiagnostics];
for (const handler of handlers) {
  const res = await handler(request, url, env);
  if (res) return res;
}
return new Response('Not found', { status: 404 });
```

6. **Do NOT move non-route code.** The alarm handler, scheduled handler, DO classes, and top-level imports that multiple routes use stay in index.js.

### Execution order

**Commit 1: Create shared utils**
- Extract `json()` helper (and any other helpers used across routes) to `src/routes/_utils.js`
- Import it in index.js where it was
- Run smoke — must still pass
- Commit: `refactor: extract json() helper to routes/_utils.js`

**Commits 2-8: Extract one domain at a time**
For each domain (ui → jobs → companies → salary → profile → operations → diagnostics):
1. Create `src/routes/{domain}.js`
2. Move the relevant `if (url.pathname ...)` blocks into an exported handler function
3. Move any imports that ONLY that domain uses
4. Update index.js to call the new handler
5. Run smoke
6. Commit: `refactor: extract {domain} routes to src/routes/{domain}.js`

DO NOT combine multiple domains in one commit. One domain per commit. If smoke breaks, fix before proceeding.

**Commit 9: Add smoke assertions**
Add assertions that verify:
- Each route file exists
- Each route file exports a handler function
- index.js imports all route handlers
- index.js line count is under 1200 (was ~2785, routes were ~1600)
- Commit: `refactor: add smoke assertions for route extraction`

**Commit 10: Update CLAUDE.md**
- Add route files to the Key Files section
- Update the Architecture section to mention the route structure
- Commit: `docs: update CLAUDE.md with route file structure`

### What NOT to do

- Do NOT rename any routes or change URL paths
- Do NOT change response shapes, status codes, or headers
- Do NOT refactor the route handler internals — just move them
- Do NOT touch ui.html, adapters.js, enrich.js, platform-do.js, or any file not involved in routing
- Do NOT combine the stripHtml commits with the router commits
- If a route handler is entangled with code that other routes also use (shared state, shared variables), leave it in index.js and document why

---

## When done

Write results to outbox/cc-refactor-results.md:

```markdown
# STAT Refactor Results
Generated: [date]
HEAD: [final commit hash]
Smoke: [final count]

## stripHtml consolidation
- Lines removed: [count]
- Inline sites replaced: [N of 5, with any skipped and why]

## Router extraction
- Route files created: [list with line counts]
- index.js reduction: [before] → [after] lines
- Routes moved: [count of 37]
- Routes left in index.js: [any, with reason]

## Commits
[hash, message, files changed for each]

## Smoke progression
[count after each commit]

## Issues encountered
[anything unexpected]
```

Update HANDOFF.md with new state. Commit: `refactor: results — stripHtml + router extraction [skip ci]`
Push to main.
