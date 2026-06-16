# CLAUDE.md — STAT Project Configuration

## What is STAT?
A personal job intelligence system monitoring healthcare IT / Epic roles across 525+ companies and 8+ ATS platforms. Deployed on Cloudflare Workers with Durable Objects. Companion relay integration via field-relay-nba MCP.

## Key Files
- `src/index.js` — Worker entry point, cron handler, alarm scheduler, route dispatcher
- `src/state.js` — JSON-wrapped state helpers (seen-ids, registry, profile, match-counts) over StateStoreDO
- `src/ui.html` — single-file UI (Matches, Browse, Companies tabs)
- `src/adapters.js` — ATS-specific fetch adapters (Workday, iCIMS, Greenhouse, Lever, Taleo, SelectMinds, Infor, Oracle HCM)
- `src/enrich.js` — description enrichment pipeline (JSON-LD, plain fetch, R2 cache)
- `src/store.js` — KV/R2 storage layer
- `src/notify.js` — alert dispatch (Pushover, email)
- `src/routes/` — HTTP route handlers, one file per domain (see below)
- `smoke.js` — 160+ structural assertions (blocks commits)
- `scripts/apply-agent.py` — browser-use auto-apply agent
- `scripts/lca-parse.js` — LCA salary data parser
- `wrangler.toml` — Cloudflare config
- `HANDOFF.md` — cross-session state (current HEAD, smoke count, priority queue)
- `docs/STAT-SNAPSHOT.txt` — system inventory snapshot
- `docs/STAT-COMMITMENTS.txt` — architectural commitments and constraints
- `docs/STAT-CLAUDE-REVIEW.txt` — required reading before UI changes

### Route structure (src/routes/)
Each file exports a single `handleX(request, url, env)` that returns a `Response` (matched its route) or `null` (try next handler). `handleFetch()` in `src/index.js` runs them in order.

- `routes/_utils.js` — shared `json()` helper
- `routes/ui.js` — `/ui`, `/`
- `routes/salary.js` — `/salary-status`, `/salary-refresh`, `/salary-load-r2`
- `routes/operations.js` — `/trigger`, `/jobhive-scan`, `/jobhive-sample`, `/jobhive-manifest`, `/batch-status`, `/logs`, `/reset-seen`, `/reset-all`
- `routes/companies.js` — `/companies` (GET+POST), `/detect-ats`, `/bootstrap`, `/platform/*`, `/harvest`
- `routes/jobs.js` — `/jobs`, `/feedback`, `/feedback/summary`, `/dispatch-apply`, `/browse`, `/backfill-browse`, `/description/:id`
- `routes/profile.js` — `/profile` (GET+POST+DELETE), `/score-job`, `/review`, `/extract-profile`, `/regenerate-keywords`, `/learning`
- `routes/diagnostics.js` — `/workday-probe`, `/plain-fetch-test`, `/br-test`, `/html-probe`, `/hc-probe`

Cron-flow helpers (`runHiringCafeScrape`, `bootstrapDOs`, `detectAts`, `generateAndStoreKeywords`, `fetchResumeFromOneDrive`, plus CSV/jobhive helpers) stay in `src/index.js` and are imported by route files via circular import — safe because those bindings are only used inside async handlers, not at module-init.

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
11. **Deploy trigger hygiene** — Never write to `src/` solely to trigger a deploy. Use `workflow_dispatch` (via GitHub API) or `outbox/.trigger-deploy`. The deploy workflow has `workflow_dispatch:` as a trigger — use it. Writing non-JS content to JS files breaks esbuild and is invisible to smoke.

## Deploy
- Sole deploy path: `.github/workflows/deploy.yml`
- Triggers: push to `src/**` on main, OR `workflow_dispatch` (manual/API)
- Pipeline: smoke.js → wrangler deploy
- `[skip ci]` in commit message skips ALL workflows
- **NEVER write to src/ just to trigger deploy** — use workflow_dispatch instead

## Workflow Automation
- **Terminal work should be automated, not left as manual steps.**
- `workflow_dispatch` workflows are triggered via GitHub API, not the Actions UI or `gh` CLI.
- Pattern: `curl -X POST .../actions/workflows/{name}/dispatches -d '{"ref":"main"}'`
- Both chat sessions (via bash_tool) and Claude Code (via bash) can trigger workflows.
- Cross-engine test workflows (`ios-safari-audit.yml`, `android-chrome-audit.yml`) are dispatched after UI changes land.
- Apply agent workflow (`apply-agent.yml`) is dispatched via the ⚡ Auto button in /ui or the `/dispatch-apply` Worker endpoint.

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
