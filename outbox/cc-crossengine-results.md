# STAT Cross-Engine Test Results
Generated: 2026-06-16
HEAD: 527a50b
Smoke: 192/192 ✅

## Files created

| File | Lines | Purpose |
|---|---:|---|
| `src/ui.html` (modified) | +9 | Global `window._statErrors` catcher (onerror + unhandledrejection) |
| `tests/stat-viewport.js` | 322 | Single test runner — iOS Safari + Android Chrome, platform detected via `IOS_DEVICE` env |
| `.github/workflows/ios-safari-audit.yml` | 173 | 3-device matrix on macOS runner |
| `.github/workflows/android-chrome-audit.yml` | 125 | 2-device matrix on KVM-accelerated ubuntu |
| `package.json` (modified) | +5 | `test:ios` / `test:android` scripts + webdriverio devDep |
| `smoke.js` (modified) | +12 assertions | Lock cross-engine wiring |

## Assertions implemented

| # | Tier | Name | What it checks |
|---|---|---|---|
| 1 | universal | no uncaught JS errors | `window._statErrors.length === 0` |
| 2 | universal | Matches tab is default active | `.tab.active[data-tab]` === `matches` |
| 3 | universal | Match cards render (or empty state shown) | `#match-list .match-card` count > 0 OR `.empty` shown — handles quiet days |
| 4 | universal | Tab bar fits or scrolls | `.tabs` either fits (`scrollWidth <= clientWidth`) or has `overflow-x: auto/scroll` |
| 5 | universal | Loading class applies during fetch | MutationObserver on `#match-list` while `loadMatches()` runs — confirms the S17 loading affordance lives in the deployed bundle |
| 6 | universal | Browse card `data-job` pattern present | Either a rendered Browse card carries `[data-job]` OR the source includes the `data-job="${encodeURIComponent(JSON.stringify(job))}"` pattern (Browse may be empty on a quiet day) |
| 7 | universal | Search input exists and is interactive | `#match-search` visible, not disabled, width > 0 |
| 8 | phone | Tab labels abbreviated below 480px | `getComputedStyle(config-tab, '::after').content` matches `Config`/`Log` OR the rendered tab is narrow enough to confirm abbreviation |
| 9 | phone | Mobile operations panel visible | `.mobile-ops` exists and `display !== 'none'` at phone width |
| 10 | phone | Mobile operations buttons ≥ 44px touch target | `.mobile-ops .sbar-btn` heights all ≥ 44px |

Universal runs on every device. Phone-only assertions run when `DEVICE_ID` starts with `P` (P1/P2/P3). The tablet device (T1) runs the 7 universal assertions only — abbreviated labels and mobile-ops panel are intentionally not visible at iPad/tablet width.

## Device matrices

**iOS Safari (`.github/workflows/ios-safari-audit.yml`)** — `macos-latest`, Xcode iOS Simulator:

| ID | Device | Orientation | Why |
|---|---|---|---|
| P1 | iPhone SE (3rd generation) | portrait | Smallest current iPhone — proves the tab-bar overflow path works at the narrowest realistic viewport |
| P2 | iPhone 16 | portrait | Standard target |
| T1 | iPad Air 11-inch (M2) | portrait | Wider layout; abbreviation and mobile-ops panel should NOT appear |

(Per the prompt: dropped FIELD's P3 + landscape T2 — STAT doesn't yet have iPad-landscape-specific UI.)

**Android Chrome (`.github/workflows/android-chrome-audit.yml`)** — KVM-accelerated `ubuntu-latest`:

| ID | Device | API | Why |
|---|---|---|---|
| P1 | Pixel 7 | 34 | Standard phone |
| T1 | Pixel Tablet | 34 | Tablet target |

(Per the prompt: dropped FIELD's Pixel 4a + Pixel 7 Pro — diminishing returns on coverage at this stage.)

## How to run

**Manual dispatch (GitHub UI)**:
1. Repo → Actions → "iOS Safari Viewport Audit" → Run workflow → main
2. Same for "Android Chrome Viewport Audit"

**Manual dispatch (gh CLI)**:
```
gh workflow run ios-safari-audit.yml --ref main
gh workflow run android-chrome-audit.yml --ref main
```

**Local dry-run (no device — just the runner code structure)**:
```
npm install              # picks up webdriverio
DEVICE_ID=P2 IOS_DEVICE='iPhone 16' npm run test:ios
DEVICE_ID=P1 npm run test:android    # needs adb/emulator
```

Workflows are `workflow_dispatch` only — they do NOT run on push (per the prompt; real-device CI minutes are expensive).

Results land in:
- `outbox/ios-{P1,P2,T1}-results.json`
- `outbox/ios-{P1,P2,T1}-screenshot.png`
- `outbox/android-{P1,T1}-results.json`
- `outbox/android-{P1,T1}-screenshot.png`

The summary job at the end of each workflow tallies `passed/total` per device for quick scanning.

## Commits

| # | Hash | Message |
|---|---|---|
| 1 | a632ec9 | `feat: global error catcher in ui.html` |
| 2 | 1d4e1e4 | `feat: cross-engine viewport test runner` (tests/stat-viewport.js + package.json) |
| 3 | 1b8e035 | `feat: iOS Safari audit workflow (3 devices)` |
| 4 | 527a50b | `feat: Android Chrome audit workflow (2 devices)` |

4 of 4 planned commits executed. Smoke 184 → 192 (+8 assertions covering the cross-engine wiring).

## Notes

- **Single-file runner, not two.** Platform detection sits on the `IOS_DEVICE` env variable presence. The runner builds either an XCUITest or a UiAutomator2 capabilities block; everything else (assertions, output shape) is identical. This is the only deviation from FIELD's pattern (FIELD uses two files); the prompt explicitly allowed it because STAT's UI is simpler.
- **No `_statReady` flag.** STAT doesn't expose a "data ready" signal the way FIELD does with `window._fieldDataReady`. The runner waits up to 25s for `#match-list` to populate (cards OR empty state), then adds a 1.5s buffer for badge/salary tail. If that polling becomes flaky in practice, exposing `window._statReady = true` at the end of `loadStatus()` would be the right next step.
- **No Playwright anywhere.** The whole point of the FIELD pattern is to drive the actual browser engine that ships on the device. Playwright's macOS WebKit is a different build.
- **No Windows.** STAT is a web app — Windows Chrome behaves identically to Linux Chrome. iOS Safari and Android Chrome are the engines that diverge.
- **No UI behavior changed.** Only addition is the `window._statErrors` catcher in `ui.html` (purely additive; nothing else touched).
