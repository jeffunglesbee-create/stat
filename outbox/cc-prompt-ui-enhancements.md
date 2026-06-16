Complete the full onboarding sequence first:

## Step 0 — Governance onboarding

1. Read CLAUDE.md
2. Read STANDARDS.md
3. Read HANDOFF.md
4. Read docs/STAT-COMMITMENTS.txt
5. Read docs/STAT-CLAUDE-REVIEW.txt — REQUIRED before any ui.html changes
6. Run: node smoke.js — confirm baseline
7. Run: git log --oneline -10

---

SESSION START · Type: C (Feature) · Scope: UI enhancements — mobile + desktop

STAT is used on both mobile (phone — primary for checking matches via Pushover alerts) and desktop (for deeper review, resume upload, company management). Every change must work on both. Test your assumptions about layout at 375px (phone) and 1200px (desktop).

This session implements the UI enhancement list (Drive: 1mrzi1SjZ90Q2kfr6l-9dhdEbedSrOjz5y0s1nwIfsSQ). Items reordered by actual user value. Some items skipped with rationale.

---

## Phase 1 — Daily use friction (do these first, one commit each)

**Commit 1: Default tab → Matches**
- Swap active class from Companies to Matches tab and tab-content.
- #1 daily friction point — every session starts on the wrong tab.
- Smoke: `read('ui.html').includes('tab active" data-tab="matches"')`
- Commit: `feat: default tab → Matches`

**Commit 2: Match count badge on tab**
- After loadMatches(), update tab label to "Matches (N)" when N > 0.
- Glanceable system health on both mobile and desktop without opening tab.
- On mobile especially valuable — see count before tapping.
- Commit: `feat: match count badge on Matches tab`

**Commit 3: Browse filter label fix**
- Fix hardcoded "remote/hybrid, no keyword match" label.
- Build filterParts dynamically based on actual active filters.
- Rule 15 violation that caused false diagnosis in S7.
- Commit: `fix: Browse filter label — dynamic based on active filters (Rule 15)`

**Commit 4: Missing ATS platforms in Browse dropdown**
- Add Oracle HCM, Infor HCM, SelectMinds to browse-ats select.
- Jobs exist in Browse but can't be filtered to.
- Commit: `feat: add Oracle HCM, Infor HCM, SelectMinds to Browse filter`

**Commit 5: Loading state on Matches/Browse**
- Add `.loading { opacity: 0.4; transition: opacity 0.15s; }` during fetch.
- On mobile over cellular, fetches take 1-2s — stale content with no indicator is confusing.
- Add class before fetch, remove in try/finally so it always clears.
- Commit: `feat: loading state on Matches and Browse fetch`

## Phase 2 — Mobile-critical fixes

**Commit 6: Tab bar overflow at phone width**
- At ≤480px: abbreviate "Configuration" → "Config", "Activity Log" → "Log".
- Add `overflow-x: auto; -webkit-overflow-scrolling: touch;` to .tabs.
- Do NOT hide tabs behind a menu — scroll is faster on mobile.
- Test: at 375px, all 6 tabs must be reachable via horizontal scroll.
- Commit: `feat: tab bar mobile — abbreviated labels + horizontal scroll`

**Commit 7: Sidebar operations on mobile**
- At ≤680px (single-column), add collapsible "Operations" section below tab content.
- Default: collapsed ("⚙ Operations" tappable header).
- On tap: expand to show sidebar buttons in 2-column grid.
- ⚡ Auto apply and Refresh are the most-needed mobile operations.
- Touch targets: minimum 44px height.
- Commit: `feat: mobile operations panel — collapsible below tab content`

## Phase 3 — Data quality

**Commit 8: browseScoreCard JSON fix**
- Replace fragile double-JSON-stringify onclick injection with data-job attribute.
- `encodeURIComponent(JSON.stringify(job))` on card div, decode in handler.
- Prevents silent rendering breaks when job descriptions contain quotes/HTML.
- Apply to Browse cards. Check if Match cards have same problem — fix if so.
- Commit: `fix: browseScoreCard — data-job attribute replaces fragile JSON injection`

**Commit 9: Feedback loop visibility**
- After review streaming, fetch /feedback/summary and show count.
- "Based on N past decisions" footer in review panel.
- Partially closes HANDOFF #7.
- Commit: `feat: feedback loop visibility — decision count in review panel`

**Commit 10: AbortController on search debounce**
- Cancel in-flight search requests when new input arrives.
- Add _matchSearchAbort and _browseSearchAbort controllers.
- Prevents stale results on slow connections (common on mobile cellular).
- Commit: `feat: AbortController on search — cancel stale requests`

## Phase 4 — Polish

**Commit 11: Config tab — replace stale interval table**
- Replace hardcoded interval table with honest text:
  "Polling is time-aware: peaks at 2-min intervals Mon–Fri 6–10am ET, backs off overnight."
- Wrong numbers are worse than no numbers.
- Commit: `fix: config tab — honest time-aware description replaces stale intervals`

**Commit 12: Backfill button relabel**
- "Backfill Browse tab" → "Recovery: Rebuild Browse"
- Add subtitle: "Only needed after manual store clear"
- Commit: `fix: relabel backfill button as recovery tool`

## Items SKIPPED

**Item 7 (Browse Claude Review)** — DEFERRED. New feature surface, depends on commit 8. Follow-up session.

**Item 8 (Resume drop zone drag events)** — DEFERRED. Drag-and-drop is desktop-only. On mobile (primary device), tap-to-upload already works. Fix in a desktop session.

**Item 11 (Activity Log server logs)** — SKIP. Diagnostic, not daily use.

**Item 13 (confirm → inline)** — SKIP. window.confirm() works on all modern browsers. Fix if it actually breaks.

**Item 15 (renderDoStatus heartbeat)** — SKIP. Performance optimization for diagnostic polling. No user-visible change.

---

## Rules

- `node smoke.js` after every commit.
- `git diff --staged` before every commit.
- Think at 375px (phone) AND 1200px (desktop) for every CSS change.
- At least one smoke assertion per commit.
- One concern per commit.
- Read docs/STAT-CLAUDE-REVIEW.txt before writing UI code.

## When done

Write to outbox/cc-ui-results.md:

```markdown
# STAT UI Enhancement Results
Generated: [date]
HEAD: [final commit hash]
Smoke: [final count]

## Commits
[hash, message, files changed]

## Smoke progression
[count after each commit]

## Mobile considerations
[CSS decisions, breakpoints, touch targets]

## Issues encountered
[anything unexpected]

## Remaining
[deferred items]
```

Update HANDOFF.md. Commit: `feat: UI results [skip ci]`
Push to main.
