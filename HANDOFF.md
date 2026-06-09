# STAT HANDOFF — 2026-06-08 (Session 12 END)

## State
HEAD (code): daf0bf0
HEAD (repo): ccf237b (auto-snapshot [skip ci])
Smoke: 113/113 ✅
CI: green (deploy run #131+)

## This Session — Full Changelog

### Performance Fixes (6 commits shipped)

- `608f1ec` fix: appendLog outside unmatchedJobs block — logs every alarm cycle
  - Was inside `if (unmatchedJobs.length > 0)` due to missing brace
  - Zero-match alarm cycles now logged; /logs and CI log-check fully visible

- `bab609c` perf: parallel alarm-start reads + promoCtx eliminates per-match StateStoreDO hops
  - Promise.all of 5 keys at alarm start (was 3 sequential)
  - promoCtx preloads match_counts + do_registry + companies; dirty flush after loop
  - maybeAddOrPromoteCompany: ctx param, falls back to individual loads (backward compat)
  - Impact: 43→13 StateStoreDO hops per alarm at 5 matches (70% reduction)

- `52e0a38` perf: parallelize total_polled + total_matches reads and writes at alarm end
  - 4 sequential DO-local ops → 2 parallel pairs. ~2ms/alarm saved.

- `4bdb9c8` perf: parallelize salary cache refresh + seen sweep in cron handler
  - maybeRunSeenSweep (up to 80s) no longer blocks jobhive scan
  - Promise.all([maybeRefreshSalaryCaches, maybeRunSeenSweep]) after HC scrape

- `78358e8` perf: CHUNK_SIZE to config + Workday chunk=25 interval=3min
  - CHUNK_SIZES exported from config.js; platform-do reads CHUNK_SIZES[this.ats] ?? 15
  - Workday: chunkSize=25, floor=180s → sweep 32.3min → 14.5min (55% faster)

- `daf0bf0` perf: ETag caching on /ui — 304 Not Modified on repeat opens
  - 32-bit hash computed at module load; If-None-Match → 304 + no body
  - ETag rotates on every deploy

### Analysis Work (no additional code)

- Two-pass performance audit (code-only → full session context)
  - Pass 2 corrected: renderDoStatus uses Promise.all (audit 1 wrong)
  - Pass 2 corrected: AbortController exists in codebase (audit 1 wrong)
  - Full comparison documented in S12 session doc

- Storage wall research: 2MB limit confirmed (SQLite-backed, not 128KB KV limit)
  - HC jobs in unmatched_jobs have no description (absent from ssrHits) — safe today
  - ADR written: docs/STAT-ADR-SQL-STORE.txt (667de42, [skip ci])
  - Decision gate documented — do not build until trigger conditions met

- Two-pass UI/UX audit → 17-item enhancement list
  - Drive: 1mrzi1SjZ90Q2kfr6l-9dhdEbedSrOjz5y0s1nwIfsSQ
  - Tier 1 (5 items, ~35 min combined): start here next UI session

## Smoke Count
97 (S11) → 113 (S12) | +16 assertions across 6 commits

## Open Items

**Carry-forward from S11:**
- #7  Feedback loop — UI visibility piece now spec'd (item 5 in UI list)
- #11 STAT_KV dead binding — wrangler.toml 3-line cleanup
- Tenet Oracle HCM — html_probe: eodr.fa.us2.oraclecloud.com
- Avature UCSF — html_probe
- Taleo tbe.taleo.net (Mount Sinai) — html_probe
- SelectMinds cursor — verify totalMatches > 0 (reached ~2000-3000 by now)
- Infor HCM — 7/8 tenants unverified

**New from S12:**
- UI enhancement list (17 items) — Drive: 1mrzi1SjZ90Q2kfr6l-9dhdEbedSrOjz5y0s1nwIfsSQ
- StateStoreDO SQL ADR — docs/STAT-ADR-SQL-STORE.txt (deferred, trigger-gated)
- Workday URL verification audit — 121 companies, none verified post-deploy (HIGH)

## How to Check STAT Status
probe_relay_route('/stat/')                            → overview
probe_relay_route('/stat/platform/selectminds/status') → cursor + totalMatches
probe_relay_route('/stat/logs?limit=5')                → recent alarm activity
stat_status MCP tool (once tool cache refreshes in new session)

## Drive Document IDs
Session 11: 1rpnrtEOxCem_EbMQ0pJ_nZHXcsW4tnz-
Session 12: 1mvdDa3vKIcY7ks8ppTnKaTkEYFi_XG6XqV6Fw2BK8u0
UI Enhancements: 1mrzi1SjZ90Q2kfr6l-9dhdEbedSrOjz5y0s1nwIfsSQ
HANDOFF'