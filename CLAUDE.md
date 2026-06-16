# CLAUDE.md — STAT Project Configuration

## What is STAT?
A personal job intelligence system monitoring healthcare IT / Epic roles across 525+ companies and 8+ ATS platforms. Deployed on Cloudflare Workers with Durable Objects. Companion relay integration via field-relay-nba MCP.

## Key Files
- `src/index.js` — Worker entry point, API routes, alarm scheduler
- `src/ui.html` — single-file UI (Matches, Browse, Companies tabs)
- `src/adapters.js` — ATS-specific fetch adapters (Workday, iCIMS, Greenhouse, Lever, Taleo, SelectMinds, Infor, Oracle HCM)
- `src/enrich.js` — description enrichment pipeline (JSON-LD, plain fetch, R2 cache)
- `src/store.js` — KV/R2 storage layer
- `src/notify.js` — alert dispatch (Pushover, email)
- `smoke.js` — 142+ structural assertions (blocks commits)
- `scripts/apply-agent.py` — browser-use auto-apply agent
- `scripts/lca-parse.js` — LCA salary data parser
- `wrangler.toml` — Cloudflare config
- `HANDOFF.md` — cross-session state (current HEAD, smoke count, priority queue)
- `docs/STAT-SNAPSHOT.txt` — system inventory snapshot
- `docs/STAT-COMMITMENTS.txt` — architectural commitments and constraints
- `docs/STAT-CLAUDE-REVIEW.txt` — required reading before UI changes

## Rules (non-negotiable)
1. **DO NOT INVENT** — never fabricate job data, company info, salary numbers, or fit scores
2. **DO NOT ASSUME** — verify before acting; read the code, check the adapter, don't guess
3. **Smoke must pass before push** — `node smoke.js` must show 0 failed
4. **Single-concern commits** — one logical change per commit
5. **Adapter fidelity** — each ATS adapter must faithfully extract what the source provides. Never synthesize fields the source doesn't return.
6. **No credentials in code** — all API keys, PATs, and secrets go in Cloudflare Worker secrets or GitHub repo secrets. field-claude-proxy holds shared AI keys.
7. **Review docs before UI changes** — read `docs/STAT-CLAUDE-REVIEW.txt` and `docs/STAT-COMMITMENTS.txt` before modifying `ui.html`
8. **Diagnosis before fix** — for adapter bugs or ATS changes, probe the source first (`html_probe` or `curl`). Never guess at selectors or page structure.
9. **Prompt architecture** — for hardware-dependent fixes (mobile viewport, Safari quirks), follow the diagnosis-first pattern from `docs/CLAUDE-CODE-PROMPT-RULES.md`. Never repeat a failed approach.
10. **Rule 59 — Trusted-but-unverified (CC-AUDIT)** — Claude Code commits are trusted but lack session context. Chat sessions that find Claude Code commits since the last HANDOFF must verify: smoke delta, feature wiring, no invented patterns, no unauthorized changes.

## Deploy
- Sole deploy path: `.github/workflows/deploy.yml`
- Trigger: push to `src/**` on main
- Pipeline: smoke.js → wrangler deploy
- `[skip ci]` in commit message skips ALL workflows

## Git
- Claude Code uses GitHub's built-in authentication (no PAT needed)
- For claude.ai chat sessions: PAT stored in memory edits (not in repo)
- Always commit with: `git config user.email "ci@stat"` and `git config user.name "STAT CI"`

## Architecture
- Cloudflare Workers (Workers Plus plan via FIELD account)
- Durable Objects: one DO per ATS platform (Workday, iCIMS, Greenhouse, etc.)
- KV: SEEN_JOBS (deduplication), STAT_CONFIG
- R2: description cache, LCA salary data
- D1: not used (FIELD uses D1 for archive — STAT uses KV/R2)
- Alerts: Pushover (instant) + Resend email
- Fit scoring: Gemini via field-claude-proxy (optional)
- Apply agent: browser-use + Claude via field-claude-proxy
- Salary intelligence: BLS OEUN series + LCA H-1B data

## Session Protocol
1. Read HANDOFF.md first — current HEAD, smoke count, open items
2. Run smoke before and after changes
3. After work: update HANDOFF.md with new state
4. For UI work: read STAT-CLAUDE-REVIEW.txt first

## ATS Adapter Reference
| ATS | Adapter | Detail enrichment | Auth required |
|-----|---------|-------------------|---------------|
| Workday | fetchWorkday | og:description (server-rendered) | No |
| iCIMS | fetchICIMS | JSON-LD (PATH A) or in_iframe body (PATH B) | No (polling), Yes (apply) |
| Greenhouse | fetchGreenhouse | JSON API | No |
| Lever | fetchLever | JSON API | No |
| Taleo | fetchTaleo | Browser Rendering (search) | No |
| SelectMinds | fetchSelectMinds | JSON API | No |
| Infor | fetchInfor | HTML scrape | No |
| Oracle HCM | fetchOracleHCM | HTML probe | No |

## field-claude-proxy Integration
AI API calls route through `field-claude-proxy.jeffunglesbee.workers.dev`:
- Auth: `X-FIELD-Relay: field-relay-cron-2026` header (server-to-server bypass)
- Force Claude: `X-FIELD-Force-Claude: true` header (bypass Gemini for complex agent calls)
- No local ANTHROPIC_API_KEY needed — proxy holds the key
