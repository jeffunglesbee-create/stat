# STAT HANDOFF — 2026-06-16 (Session 16 END)

## State
HEAD: 448f23e
Smoke: 162/162 ✅
Active DOs: 126 | Companies: 525 | Seen IDs: 2,840

## Session 16 — stripHtml consolidation + handleFetch router extraction

11 commits on main implementing the structure-only refactor specified by
`outbox/cc-prompt-refactor.md`.

**stripHtml** — upgraded the shared helper to handle script/style block
removal + named/numeric entity decoding, then replaced 5 inline strippers
in enrich.js with calls to it. SelectMinds site kept inline because it
pre-strips page-specific `<nav>`/`<header>` blocks.

**Router extraction** — moved all 38 routes out of handleFetch into
`src/routes/{ui,salary,operations,companies,jobs,profile,diagnostics}.js`.
index.js: 2,785 → 1,107 lines. Created `src/state.js` (state helpers
shared by cron + routes) and `src/routes/_utils.js` (json() helper).

Cron-flow helpers (bootstrapDOs, runHiringCafeScrape, detectAts,
generateAndStoreKeywords, fetchResumeFromOneDrive, plus the jobhive CSV
helpers) stay in index.js but are exported so route files import them
circularly — safe because they're only referenced inside async handlers.

Full execution notes + commit-by-commit smoke progression:
`outbox/cc-refactor-results.md`.

## Session 15 — Optimization Audit + Execute

Two-phase Claude Code session: audit then fix.

**Audit** (committed on branch `claude/jolly-johnson-mq9llj`, merged to main):
- `outbox/cc-optimization-audit.md` — P1/P2/P3 findings against full src/

**Execute** — 9 commits on main:
1. 956bf2e — remove 12 unreachable smoke assertions (post-exit dead code)
2. 54c3fed — batch.js customKeywords undeclared → restores BatchPollerDO alerts
3. 6deffd1 — remove dead NEEDS_BROWSER_FETCH branches in enrich.js
4. 1ad24cc — remove dead STAT_KV binding (closes carry-forward #11)
5. 4e46bbc — remove 3 dead HiringCafe exports (~130 lines)
6. 545209f — AbortSignal.timeout on 10 adapter + 4 Gemini fetches
7. ddda036 — archive 8 orphan research scripts to scripts/_archive/
8. 789b65a — log adapter and dedup catch blocks (Rule 9)
9. 5d4216c — P3 cleanup (parallel store reads, hoisted HC term filter)

Filter-order alignment commit skipped — audit was wrong; batch.js and platform-do.js already agree, smoke already locks the invariant.

Full execution notes: `outbox/cc-optimization-results.md`.

## This Session — Full Changelog

### iCIMS JSON-LD Enrichment (bc4b435)
- fetchICIMSJsonLd() in enrich.js — PATH A (preferred)
- Extracts title, description, location, salary, datePosted from Jibe wrapper
- PATH B fallback: existing in_iframe body text extraction
- Confirmed on Mercy Medical Center (careers.stellamaris.org) job 13529
- Smoke: 134 → 137

### Apply Agent Prototype (fcd9884)
- scripts/apply-agent.py — browser-use + LLM agent for universal form filling
- .github/workflows/apply-agent.yml — CI trigger via outbox/.apply-* or manual dispatch
- No per-ATS selectors — agent navigates any career site dynamically
- Based on ApplyPilot (1k stars) pattern
- Smoke: 137 → 140

### Auto-Apply Dispatch (322ed8b)
- ⚡ Auto button on match cards in UI
- POST /dispatch-apply Worker endpoint → GitHub Actions API
- Requires STAT_PAT Worker secret: `wrangler secret put STAT_PAT`
- Smoke: 140 → 142

### Setup Automation (da2ed12)
- scripts/setup-apply.sh — automated profile setup, Jeffrey Unglesbee defaults
- Screening question guidance tuned for 3+ years Epic Ambulatory experience
- data/ added to .gitignore (profile + resume are sensitive)

### Zero-Config API Key (313a445)
- Routes through field-claude-proxy — no local ANTHROPIC_API_KEY needed
- X-FIELD-Relay header auth + X-FIELD-Force-Claude for agent routing
- Proxy v8 deployed (3fe9dc8 in field-relay-nba)

### Claude Code Governance
- CLAUDE.md — project config, rules, session protocol, adapter reference
- .claude/settings.json — SessionStart hook config
- .claude/hooks/session-start.sh — auto smoke check + state print

## Smoke Count
134 (S13) → 142 (S14) | +8 assertions

## Open Items

**Carry-forward:**
- #7  Feedback loop UI visibility (item 5 in UI enhancement list)
- ~~#11 STAT_KV dead binding~~ — closed in commit 1ad24cc
- SelectMinds cursor verification
- Workday URL audit (121 companies)
- UI enhancement list (17 items) — Drive: 1mrzi1SjZ90Q2kfr6l-9dhdEbedSrOjz5y0s1nwIfsSQ
- handleFetch() router extraction (deferred from S15 audit — TYPE C)
- stripHtml() helper upgrade + inline call-site dedup (deferred from S15)

**New from S14:**
- Apply agent dry-run test — pending: `bash scripts/setup-apply.sh` then run against Risant Health 9/10
- STAT_PAT Worker secret — `wrangler secret put STAT_PAT` for ⚡ Auto button
- iCIMS JSON-LD verification — confirm JSON-LD present on *.icims.com domain (not just branded wrappers)
- Cookie domain question — still unresolved (needed only for Phase 2 apply)
- Apply agent Phase 2 — automated form submission (deferred, complex multi-step flow)

**Audit (S15, 2026-06-16):**
- Full codebase optimization audit written to `outbox/cc-optimization-audit.md`
- 3 P1 latent bugs found: batch.js `customKeywords` ReferenceError (silently swallowed), enrich.js `NEEDS_BROWSER_FETCH` undefined references, smoke.js 12 duplicate assertions (lines 303-316 copy 249-261)
- Chat session to review and dispatch fixes as TYPE B commits

## Drive Documents
Session 14: (this session, chat-only)
iCIMS Cookie & Apply Spec: 1D5VC5m2ESjT-eX9qBE8QRTQjfRF0cLMwumzYFjWQQ8Y
UI Enhancements: 1mrzi1SjZ90Q2kfr6l-9dhdEbedSrOjz5y0s1nwIfsSQ

## How to Check STAT Status
stat_status MCP tool → overview (active DOs, companies, seen IDs)
probe_relay_route('/stat/') → full status
probe_relay_route('/stat/jobs?limit=5') → recent matches
