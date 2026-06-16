#!/usr/bin/env node
// tests/stat-viewport.js — STAT cross-engine viewport audit (Appium + WebDriverIO)
//
// Runs against the deployed STAT dashboard on real browser engines:
//   - iOS Safari (XCUITest, macos runner, ENV IOS_DEVICE set)
//   - Android Chrome (UiAutomator2, ubuntu runner, ENV IOS_DEVICE unset)
//
// Why not Playwright? Playwright on macOS uses a non-shipping WebKit build —
// FIELD repeatedly missed real iOS Safari scroll bugs that only reproduce on
// the production WebKit engine. This runner drives the actual Safari that
// ships on iOS Simulator and the actual Chrome that ships on Android.
//
// ENV:
//   DEVICE_ID — P1/P2/T1 etc. Drives the IS_PHONE/IS_TABLET branches.
//   IOS_DEVICE — present on iOS runner. Triggers xcuitest capabilities.
//   IOS_VERSION, DEVICE_UDID — iOS only (workflow sets them).
//   ANDROID_DEVICE — present on Android runner; defaults to emulator-5554.
//
// Output: JSON to stdout. Each assertion: { id, name, pass, actual, error? }

const { remote } = require('webdriverio');

const LIVE_URL = 'https://stat-job-watcher.jeffunglesbee.workers.dev/ui';

const DEVICE_ID = process.env.DEVICE_ID || 'P2';
const IS_PHONE = ['P1', 'P2', 'P3'].includes(DEVICE_ID);
const IS_TABLET = ['T1', 'T2'].includes(DEVICE_ID);

const IOS_DEVICE = process.env.IOS_DEVICE;
const IOS_VERSION = process.env.IOS_VERSION || '18.1';
const DEVICE_UDID = process.env.DEVICE_UDID || undefined;
const ANDROID_DEVICE = process.env.ANDROID_DEVICE || 'emulator-5554';
const IS_IOS = !!IOS_DEVICE;

// ── Assertion definitions ────────────────────────────────────────────────────

const UNIVERSAL = [
  {
    id: '#1', name: 'no uncaught JS errors',
    fn: async (browser) => {
      const errors = await browser.execute(() => window._statErrors || []);
      return { pass: errors.length === 0, actual: errors.length === 0 ? 'clean' : errors };
    }
  },
  {
    id: '#2', name: 'Matches tab is default active',
    fn: async (browser) => {
      const tab = await browser.execute(() =>
        document.querySelector('.tab.active')?.dataset.tab || null
      );
      return { pass: tab === 'matches', actual: tab };
    }
  },
  {
    id: '#3', name: 'Match cards render (or empty state shown)',
    fn: async (browser) => {
      const state = await browser.execute(() => {
        const cards = document.querySelectorAll('#match-list .match-card').length;
        const empty = document.querySelector('#match-list .empty') !== null;
        return { cards, empty };
      });
      return {
        pass: state.cards > 0 || state.empty,
        actual: state.cards > 0 ? `${state.cards} cards` : state.empty ? 'empty-state shown' : 'neither cards nor empty state'
      };
    }
  },
  {
    id: '#4', name: 'Tab bar horizontally scrollable or fits',
    fn: async (browser) => {
      const metrics = await browser.execute(() => {
        const tabs = document.querySelector('.tabs');
        if (!tabs) return null;
        const cs = getComputedStyle(tabs);
        return {
          overflowX: cs.overflowX,
          scrollWidth: tabs.scrollWidth,
          clientWidth: tabs.clientWidth,
        };
      });
      if (!metrics) return { pass: false, actual: 'no .tabs element' };
      // Pass if either: tabs fit (scrollWidth <= clientWidth) OR overflow-x
      // scroll is configured so users can reach them.
      const fits = metrics.scrollWidth <= metrics.clientWidth;
      const scrollable = ['auto', 'scroll'].includes(metrics.overflowX);
      return { pass: fits || scrollable, actual: metrics };
    }
  },
  {
    id: '#5', name: 'Loading class applies during fetch',
    fn: async (browser) => {
      // Trigger a fresh loadMatches() and observe whether .loading appears
      // on #match-list at any point during the call.
      const observed = await browser.execute(async () => {
        const el = document.getElementById('match-list');
        if (!el) return { saw: false, reason: 'no #match-list' };
        let saw = false;
        const obs = new MutationObserver(() => {
          if (el.classList.contains('loading')) saw = true;
        });
        obs.observe(el, { attributes: true, attributeFilter: ['class'] });
        try {
          if (typeof loadMatches === 'function') await loadMatches();
        } catch (e) { /* loadMatches errors are caught by #1 */ }
        obs.disconnect();
        return { saw };
      });
      return { pass: observed.saw === true, actual: observed };
    }
  },
  {
    id: '#6', name: 'Browse card data-job attribute present in source',
    fn: async (browser) => {
      // Browse may be empty on a quiet day. The actionable thing here is to
      // confirm the renderer source uses the data-job pattern — proves the
      // S17 fix is live in the deployed bundle.
      const result = await browser.execute(() => {
        const src = document.documentElement.outerHTML;
        return {
          hasPattern: src.includes('data-job="${encodeURIComponent(JSON.stringify(job))}"'),
          renderedCard: !!document.querySelector('#browse-list [data-job]'),
        };
      });
      return {
        pass: result.hasPattern || result.renderedCard,
        actual: result.renderedCard ? 'rendered card has data-job' : result.hasPattern ? 'source uses data-job pattern' : 'neither found'
      };
    }
  },
  {
    id: '#7', name: 'Search input exists and is interactive',
    fn: async (browser) => {
      const state = await browser.execute(() => {
        const input = document.getElementById('match-search');
        if (!input) return { exists: false };
        const cs = getComputedStyle(input);
        return {
          exists: true,
          visible: cs.display !== 'none' && cs.visibility !== 'hidden',
          disabled: input.disabled,
          width: input.getBoundingClientRect().width,
        };
      });
      return {
        pass: state.exists && state.visible && !state.disabled && state.width > 0,
        actual: state
      };
    }
  },
];

const PHONE_ONLY = [
  {
    id: '#8', name: 'Tab labels abbreviated below 480px',
    fn: async (browser) => {
      const result = await browser.execute(() => {
        const configTab = document.querySelector('.tab[data-tab="config"]');
        const logTab = document.querySelector('.tab[data-tab="log"]');
        if (!configTab || !logTab) return { error: 'missing tabs' };
        const cfgAfter = getComputedStyle(configTab, '::after').content;
        const logAfter = getComputedStyle(logTab, '::after').content;
        return {
          configAfter: cfgAfter,
          logAfter,
          configWidth: configTab.getBoundingClientRect().width,
          logWidth: logTab.getBoundingClientRect().width,
          viewportWidth: window.innerWidth,
        };
      });
      if (result.error) return { pass: false, actual: result };
      // Either ::after carries the abbreviated label, OR the rendered tab
      // is narrow enough to confirm the short form is visible. Quoting on
      // computed content varies across engines (Safari includes quotes).
      const abbreviated =
        /Config/.test(result.configAfter) ||
        /Log/.test(result.logAfter) ||
        result.configWidth < 90;
      return { pass: abbreviated, actual: result };
    }
  },
  {
    id: '#9', name: 'Mobile operations panel exists and is visible',
    fn: async (browser) => {
      const result = await browser.execute(() => {
        const panel = document.querySelector('.mobile-ops');
        if (!panel) return { exists: false };
        const cs = getComputedStyle(panel);
        return {
          exists: true,
          display: cs.display,
          viewportWidth: window.innerWidth,
        };
      });
      return {
        pass: result.exists && result.display !== 'none',
        actual: result
      };
    }
  },
  {
    id: '#10', name: 'Mobile operations buttons meet 44px touch target',
    fn: async (browser) => {
      const heights = await browser.execute(() => {
        const buttons = document.querySelectorAll('.mobile-ops .sbar-btn');
        return Array.from(buttons).map(b => ({
          id: b.id,
          height: b.offsetHeight,
        }));
      });
      if (heights.length === 0) {
        return { pass: false, actual: 'no .mobile-ops buttons found' };
      }
      const failures = heights.filter(h => h.height < 44);
      return { pass: failures.length === 0, actual: heights };
    }
  },
];

// ── Runner ───────────────────────────────────────────────────────────────────

async function run() {
  const assertions = [...UNIVERSAL];
  if (IS_PHONE) assertions.push(...PHONE_ONLY);

  const label = IS_IOS ? `[ios-safari] ${IOS_DEVICE}` : `[android-chrome] ${ANDROID_DEVICE}`;
  console.error(`${label} (${DEVICE_ID}), ${assertions.length} assertions`);

  let browser;
  try {
    browser = await remote(IS_IOS ? {
      port: 4723,
      connectionRetryTimeout: 600000,  // 10 min — WDA compile + sim boot
      connectionRetryCount: 1,
      capabilities: {
        platformName: 'iOS',
        'appium:automationName': 'XCUITest',
        'appium:browserName': 'Safari',
        'appium:deviceName': IOS_DEVICE,
        'appium:platformVersion': IOS_VERSION,
        ...(DEVICE_UDID ? { 'appium:udid': DEVICE_UDID } : {}),
        'appium:noReset': true,
        'appium:wdaLaunchTimeout': 600000,
        'appium:wdaConnectionTimeout': 600000,
        'appium:simulatorStartupTimeout': 300000,
        'appium:wdaStartupRetries': 3,
      },
      logLevel: 'warn',
    } : {
      port: 4723,
      capabilities: {
        platformName: 'Android',
        'appium:automationName': 'UiAutomator2',
        'appium:browserName': 'Chrome',
        'appium:deviceName': ANDROID_DEVICE,
        'appium:noReset': true,
        'appium:chromedriverAutodownload': true,
      },
      logLevel: 'warn',
    });

    await browser.url(LIVE_URL);

    // Wait for loadStatus → loadMatches to finish (matches list rendered).
    // STAT doesn't expose a _ready flag; poll for either match cards or the
    // empty-state element to appear, with a 25s ceiling.
    let ready = false;
    for (let i = 0; i < 50; i++) {
      ready = await browser.execute(() => {
        const list = document.getElementById('match-list');
        return !!list && (list.children.length > 0);
      });
      if (ready) break;
      await browser.pause(500);
    }
    if (!ready) console.error(`${label} WARNING: match-list never populated`);

    // Small buffer for any async tail (salary status, badge update).
    await browser.pause(1500);

    const results = [];
    for (const assertion of assertions) {
      try {
        const r = await assertion.fn(browser);
        results.push({ id: assertion.id, name: assertion.name, ...r });
      } catch (err) {
        results.push({
          id: assertion.id, name: assertion.name,
          pass: false, actual: `ERROR: ${err.message}`,
        });
      }
    }

    const output = {
      device: IS_IOS ? IOS_DEVICE : ANDROID_DEVICE,
      deviceId: DEVICE_ID,
      platform: IS_IOS ? 'ios-safari' : 'android-chrome',
      tier: IS_PHONE ? 'phone' : IS_TABLET ? 'tablet' : 'unknown',
      timestamp: new Date().toISOString(),
      dataReady: ready,
      total: results.length,
      passed: results.filter(r => r.pass).length,
      failed: results.filter(r => !r.pass).length,
      assertions: results,
    };

    console.log(JSON.stringify(output, null, 2));
    return output.failed;
  } catch (err) {
    console.error(`${label} FATAL: ${err.message}`);
    console.log(JSON.stringify({
      device: IS_IOS ? IOS_DEVICE : ANDROID_DEVICE,
      deviceId: DEVICE_ID,
      platform: IS_IOS ? 'ios-safari' : 'android-chrome',
      error: err.message, assertions: [],
    }, null, 2));
    return 1;
  } finally {
    if (browser) await browser.deleteSession().catch(() => {});
  }
}

run().then(failures => process.exit(failures > 0 ? 1 : 0));
