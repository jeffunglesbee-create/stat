Complete the full onboarding sequence first:

## Step 0 — Governance onboarding

1. Read CLAUDE.md
2. Read STANDARDS.md
3. Read HANDOFF.md
4. Run: node smoke.js — confirm baseline
5. Run: git log --oneline -10

Then read these FIELD reference files (the pattern you are porting):
- Read the FIELD repo at https://github.com/jeffunglesbee-create/jubilant-bassoon (clone it to /tmp/field-ref if needed)
- Specifically read: tests/ios-safari-viewport.js, tests/android-chrome-viewport.js
- Specifically read: .github/workflows/ios-safari-audit.yml, .github/workflows/android-chrome-audit.yml

---

SESSION START · Type: C (Feature) · Scope: Cross-engine viewport testing — iOS Safari + Android Chrome

STAT's UI was just updated with 12 mobile/responsive changes (tab bar scroll, mobile ops panel, touch targets, loading states). These need real-engine verification on iOS Safari and Android Chrome. Playwright can't test real Safari WebKit — FIELD proved this when it missed iOS scroll bugs 5 times.

FIELD already built a $0/mo Appium + WebDriverIO testing infrastructure on GitHub Actions. This session ports that pattern to STAT.

---

## Architecture (copy from FIELD, adapt for STAT)

**iOS Safari:** GitHub Actions `macos-latest` → Xcode iOS Simulator (pre-installed) → Appium + XCUITest → WebDriverIO → real Safari WebKit

**Android Chrome:** GitHub Actions `ubuntu-latest` → KVM-accelerated Android Emulator → Appium + UiAutomator2 → WebDriverIO → real Chrome

**Both:** `workflow_dispatch` only (manual trigger). JSON results to outbox/. Screenshots captured on every run.

---

## Step 1: Create the test runner — tests/stat-viewport.js

Single test file for both platforms (FIELD uses two files; STAT is simpler so one file with platform detection is cleaner).

```
LIVE_URL = 'https://stat-job-watcher.jeffunglesbee.workers.dev/ui'
```

### Assertions to implement (10 total)

UNIVERSAL (run on all devices):

```
#1 — No uncaught JS errors
  Check window._statErrors or equivalent global error catcher.
  If STAT doesn't have one, add a small window.onerror handler in ui.html
  that pushes to window._statErrors = [].

#2 — Matches tab is default active
  document.querySelector('.tab.active')?.dataset.tab === 'matches'

#3 — Match cards render
  document.querySelectorAll('.match-card').length > 0
  (May be 0 if no matches — check for either cards OR the "no matches" message)

#4 — Tab bar horizontally scrollable
  const tabs = document.querySelector('.tabs');
  tabs.scrollWidth > tabs.clientWidth (on narrow viewports)
  OR all tabs reachable (scrollWidth === clientWidth on wide viewports)

#5 — Loading state applies during fetch
  Trigger a loadMatches() and check that .loading class appears.
  (This may need a MutationObserver or a short delay check)

#6 — data-job attribute present on browse cards
  Navigate to Browse tab, check document.querySelector('[data-job]') exists.
  If Browse is empty, check that the renderBrowseCard function source includes 'data-job'.

#7 — Search input exists and is interactive
  document.querySelector('#match-search') is visible and accepts input.
```

PHONE ONLY (≤480px viewport — iPhone SE, iPhone 16):

```
#8 — Tab labels abbreviated
  The tab for Configuration should render as "Config" (via CSS ::after).
  Check: getComputedStyle(configTab, '::after').content !== 'none'
  OR: configTab.getBoundingClientRect().width < 120 (abbreviated fits tighter)

#9 — Mobile operations panel exists
  document.querySelector('.mobile-ops') is present in DOM.
  On phone width, its display is not 'none'.

#10 — Touch targets ≥ 44px
  All .mobile-ops button elements have offsetHeight >= 44.
```

### Test runner structure

Follow FIELD's pattern exactly:
- Accept env vars: DEVICE_ID, IOS_DEVICE, IOS_VERSION, DEVICE_UDID (iOS) or ANDROID_DEVICE (Android)
- Platform detection: if IOS_DEVICE is set, use xcuitest capabilities. Else use uiautomator2.
- Output: JSON to stdout with { device, deviceId, platform, passed, failed, total, assertions: [...] }
- Each assertion: { id, name, pass, actual, error? }

## Step 2: Create iOS workflow — .github/workflows/ios-safari-audit.yml

Port FIELD's ios-safari-audit.yml with these changes:
- 3-device matrix (not 5 — STAT doesn't need iPad landscape):
  - iPhone SE (3rd generation) — id: P1 (smallest phone, tests overflow)
  - iPhone 16 — id: P2 (standard phone)
  - iPad Air 11-inch (M2) — id: T1, portrait (tablet, tests wider layout)
- Point at tests/stat-viewport.js instead of tests/ios-safari-viewport.js
- Upload results to outbox/ios-{id}-results.json
- Screenshot after run
- Summary job at end

Keep FIELD's patterns exactly for:
- Simulator boot + wait
- Appium install + start + health check
- Orientation handling
- Artifact upload

## Step 3: Create Android workflow — .github/workflows/android-chrome-audit.yml

Port FIELD's android-chrome-audit.yml with these changes:
- 2-device matrix (not 4):
  - Pixel 7 — id: P1, api: 34 (standard phone)
  - Pixel Tablet — id: T1, api: 34 (tablet)
- Point at tests/stat-viewport.js
- Same KVM enable, Appium + UiAutomator2 install pattern

## Step 4: Add error catcher to ui.html

If ui.html doesn't already have a global error catcher, add one at the top of the script section:

```javascript
window._statErrors = [];
window.onerror = function(msg, src, line, col, err) {
  window._statErrors.push({ msg, src, line, col, stack: err?.stack });
};
```

This enables assertion #1 to detect runtime errors on real devices.

## Step 5: Smoke assertions

Add assertions:
- `stat-viewport test file exists` — tests/stat-viewport.js
- `ios-safari-audit workflow exists` — .github/workflows/ios-safari-audit.yml
- `android-chrome-audit workflow exists` — .github/workflows/android-chrome-audit.yml
- `ui.html has global error catcher` — read('ui.html').includes('_statErrors')

## Step 6: Update package.json

Add to scripts:
```json
"test:ios": "node tests/stat-viewport.js",
"test:android": "node tests/stat-viewport.js"
```

Add webdriverio to devDependencies:
```json
"webdriverio": "^9.0.0"
```

---

## Commit plan

| # | Message | Files |
|---|---------|-------|
| 1 | `feat: global error catcher in ui.html` | src/ui.html, smoke.js |
| 2 | `feat: cross-engine viewport test runner` | tests/stat-viewport.js, package.json, smoke.js |
| 3 | `feat: iOS Safari audit workflow (3 devices)` | .github/workflows/ios-safari-audit.yml, smoke.js |
| 4 | `feat: Android Chrome audit workflow (2 devices)` | .github/workflows/android-chrome-audit.yml, smoke.js |

Run smoke after each commit. 4 commits total.

## What NOT to do

- Do NOT use Playwright. The whole point is real browser engines via Appium.
- Do NOT make the workflows run on push. They are workflow_dispatch only (manual trigger). Real device tests are expensive in CI minutes.
- Do NOT test FIELD's URL. Point at STAT's deployed URL only.
- Do NOT add Windows testing. STAT is a web app — Windows Chrome behaves identically to Linux Chrome. iOS Safari and Android Chrome are the engines that diverge.
- Do NOT modify any UI behavior. This session is test infrastructure only.

---

## When done

Write to outbox/cc-crossengine-results.md:

```markdown
# STAT Cross-Engine Test Results
Generated: [date]
HEAD: [final commit hash]
Smoke: [final count]

## Files created
[list with line counts]

## Assertions implemented
[list all 10 with descriptions]

## Device matrices
iOS: [devices]
Android: [devices]

## How to run
[exact commands for manual dispatch]

## Commits
[hash, message, files]
```

Update HANDOFF.md. Commit: `feat: cross-engine test results [skip ci]`
Push to main.
