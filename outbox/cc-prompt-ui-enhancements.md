Complete the full onboarding sequence first:

## Step 0 — Governance onboarding

1. Read CLAUDE.md
2. Read STANDARDS.md
3. Read HANDOFF.md
4. Read docs/STAT-CLAUDE-REVIEW.txt — REQUIRED before any UI changes
5. Read docs/STAT-COMMITMENTS.txt
6. Run: node smoke.js — confirm baseline
7. Run: git log --oneline -10

---

SESSION START · Type: C (Feature) · Scope: UI enhancements from audit list — user-facing improvements only

Reference: the full 17-item list is at Drive ID 1mrzi1SjZ90Q2kfr6l-9dhdEbedSrOjz5y0s1nwIfsSQ
but you do NOT need to read it — this prompt contains everything you need with reviewed scope.

This prompt implements 11 of 17 items. 6 items were cut during review (see SKIPPED section below).
Work on main. One commit per item. Smoke after every commit.

---

## Items to implement (in this order)

### Commit 1: Default tab → Matches
FILE: src/ui.html
Swap the `active` class from the Companies tab/content to the Matches tab/content.
Four class attribute changes. loadMatches() is already called on tab activation.
Commit: `ui: default tab → Matches`

### Commit 2: Browse filter label fix
FILE: src/ui.html — loadBrowse()
The filterParts array unconditionally shows 'remote/hybrid, no keyword match' even when the user has selected an ATS filter. Fix:
```js
const filterParts = [];
if (atsFilter) filterParts.push(atsFilter);
filterParts.push('remote/hybrid');
if (!atsFilter && !q) filterParts.push('no keyword match');
```
Commit: `ui: fix Browse filter label — Rule 15 compliance`

### Commit 3: Missing ATS platforms in Browse dropdown
FILE: src/ui.html — browse-ats select element
Add three options after the existing ones:
```html
<option value="oracle_hcm">Oracle HCM</option>
<option value="infor_hcm">Infor HCM</option>
<option value="selectminds">SelectMinds</option>
```
Commit: `ui: add Oracle HCM, Infor, SelectMinds to Browse filter`

### Commit 4: Feedback loop visibility
FILE: src/ui.html — after review streaming completes
After the SSE stream finishes in toggleReview(), fetch /feedback/summary and append a note showing how many past decisions informed the review:
```js
const feedbackRes = await api('/feedback/summary');
const n = feedbackRes.data?.count ?? 0;
if (n > 0) {
  contentEl.insertAdjacentHTML('beforeend',
    '<div class="review-footer" style="margin-top:8px;font-size:11px;color:var(--dim)">Based on ' + n + ' past decision' + (n===1?'':'s') + '</div>');
}
```
Commit: `ui: show feedback decision count in review panel — partial close #7`

### Commit 5: Match count badge
FILE: src/ui.html — after loadMatches() resolves
After rendering matches, update the tab label:
```js
const tab = document.querySelector('[data-tab="matches"]');
tab.textContent = 'Matches' + (total > 0 ? ' (' + total + ')' : '');
```
Reset to 'Matches' on error. Use whatever variable holds the total count from the API response.
Commit: `ui: match count badge on tab label`

### Commit 6: Loading state on fetch
FILE: src/ui.html — loadMatches() and loadBrowse()
Add CSS: `.loading { opacity: 0.4; transition: opacity 0.15s; }`
Add classList.add('loading') before fetch, classList.remove('loading') after (in both success and error paths).
Apply to the match-list and browse-list containers.
Commit: `ui: loading opacity on Matches/Browse fetch`

### Commit 7: browseScoreCard JSON fix
FILE: src/ui.html — Browse card rendering
Replace the fragile double-JSON-encoded onclick attribute with a data attribute:
- Store job on card: `data-job="${encodeURIComponent(JSON.stringify(job))}"`
- In browseScoreCard handler: `const job = JSON.parse(decodeURIComponent(btn.closest('.match-card').dataset.job));`
Remove the old inline JSON.stringify serialization.
Commit: `ui: fix browseScoreCard JSON — data attribute instead of onclick injection`

### Commit 8: Browse tab Review button
FILE: src/ui.html — Browse card rendering + new toggleBrowseReview function
PREREQUISITE: Commit 7 must be done first.
Add a ✦ Review button to Browse cards. Create toggleBrowseReview() that:
1. Gets job from data-job attribute (same as commit 7 pattern)
2. Calls /review with the job data (same SSE streaming as Matches review)
3. Renders into a review panel div below the card
Reuse as much of the existing toggleReview() code as possible.
Commit: `ui: Browse tab Claude Review button — reuses /review SSE infrastructure`

### Commit 9: Config tab — honest interval display
FILE: src/ui.html — Configuration tab content
Replace the hardcoded interval table with honest text:
"Polling is time-aware: peaks at 2-minute intervals Mon–Fri 6–10am ET, backs off to 8–20 minutes overnight and weekends. See STAT-ARCHITECTURE.txt for full schedule."
Do NOT build live interval polling. Static honest text is better than stale numbers.
Commit: `ui: replace stale interval table with time-aware description`

### Commit 10: Activity Log — server logs
FILE: src/ui.html — tab-log activation handler
On log tab activation, fetch /logs?limit=30 and prepend server log entries above the existing session log. Add a "Server Log" / "Session Log" section divider.
Format each entry as: `[timestamp] [ats] polled:N matches:N`
Commit: `ui: wire Activity Log to /logs endpoint`

### Commit 11: Mobile sidebar access
FILE: src/ui.html — below tab content area, inside @media (max-width: 680px)
Add a collapsible "⋯ Operations" section at the bottom of single-column layout. Show the sidebar operation buttons (Bootstrap, HiringCafe scan, Refresh, Clear seen IDs) in a simple vertical stack. Toggle open/closed on tap.
Keep it minimal — no grid, just stacked buttons with the same .sbar-btn class.
Commit: `ui: mobile Operations section — sidebar buttons accessible at ≤680px`

### Final commit: Smoke assertions
Add one smoke assertion per shipped item. Suggested checks:
- 'tab-matches' has 'active' class in default HTML
- browse filter builds filterParts dynamically
- 'oracle_hcm' option in browse-ats select
- '/feedback/summary' fetch in toggleReview
- 'data-job' attribute pattern in Browse rendering
- '.loading' CSS class defined
- 'toggleBrowseReview' function defined
- '/logs?limit' in tab-log handler
- '@media' section with Operations for mobile
Commit: `ui: smoke assertions for 11 UI enhancements`

---

## SKIPPED items (reviewed and cut)

**Item 4 (Backfill button relabel)** — Cosmetic. Solo developer knows what the button does. Not worth a commit.

**Item 8 (Resume drop zone drag events)** — Jeff primarily uses STAT on mobile (phone/iPad). Drag-and-drop is a desktop-only interaction. The click-to-upload path works on all devices. Ship when there's a desktop use case.

**Item 10 (AbortController on search debounce)** — Theoretical race condition for a single-user app. The stale-results window is milliseconds. Not worth the complexity.

**Item 13 (confirm → inline confirmation)** — Jeff uses STAT on his phone, not a hospital kiosk. confirm() works fine on iOS Safari. Solve if it actually breaks somewhere.

**Item 15 (renderDoStatus heartbeat reduction)** — It works. The 7-10 parallel calls every 30s are lightweight GETs to local DOs, not external APIs. Premature optimization.

**Item 16 (Tab bar overflow at 375px)** — Jeff's screenshots show iPad-width viewports. If he reports tab clipping on his phone, address then.

---

## Rules

- Read docs/STAT-CLAUDE-REVIEW.txt BEFORE touching ui.html
- One item per commit, smoke after each
- If an item is more complex than described, STOP and document why in the output file
- Do NOT refactor unrelated code while in ui.html
- Do NOT change any API endpoints or Worker code — UI only (except smoke.js)

## When done

Write results to outbox/cc-ui-results.md:

```markdown
# STAT UI Enhancement Results
Generated: [date]
HEAD: [final commit hash]
Smoke: [final count]

## Commits
[hash, message, lines changed]

## Smoke progression
[count after each commit]

## Issues encountered
[anything unexpected]
```

Update HANDOFF.md. Commit with [skip ci]. Push to main.
