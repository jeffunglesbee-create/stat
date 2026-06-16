# STAT HANDOFF — 2026-06-16 (Session 14 END)

## State
HEAD: 313a445
Smoke: 142/142 ✅
Active DOs: 126 | Companies: 525 | Seen IDs: 2,840

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
- #11 STAT_KV dead binding — wrangler.toml 3-line cleanup
- SelectMinds cursor verification
- Workday URL audit (121 companies)
- UI enhancement list (17 items) — Drive: 1mrzi1SjZ90Q2kfr6l-9dhdEbedSrOjz5y0s1nwIfsSQ

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
