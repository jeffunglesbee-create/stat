# STAT HANDOFF — 2026-06-08 (Session 11 END)

## State
HEAD (code): 86495b9
HEAD (repo): f92499d (probe [skip ci])
Smoke: 97/97 ✅
CI: green (deploy run #130)
Relay: 8dad045 (stat_status MCP tool deployed)

## This Session — Full Changelog

### SelectMinds Cursor — 3 bugs fixed
- `466e1cf` fix: cursor persistence + Browse model change
  - BUG 1: SELECTMINDS_MIN_ID=2000 silently overrode config token 1000 via Math.max
  - BUG 2: loop used `startId` not `effectiveStart` — wrap never applied
  - BUG 3: cursor never persisted — every cycle restarted from static config token
  - Fix: cursor stored in DO storage 'selectminds_cursor', returned as jobs._nextCursor
  - Browse: ALL env-filtered jobs now captured (matched + unmatched), not just non-matching
- `86495b9` fix: cursor visible in status endpoint; url-keyed bootstrap merge
  - selectmindsCursor exposed in /platform/selectminds/status response
  - bootstrapDOs merge key changed from (ats,token) to (ats,url) — prevents duplicate
    UTMB entries when token changes (was causing polled:2 instead of polled:1)

### stat_status MCP Tool (relay — 8dad045)
- New tool: stat_status(platform?) on the FIELD relay MCP server
  - Returns overview (activeDOs, watchedCompanies, seenJobIds, fitScoring, salary)
  - + optional platform-specific status with selectmindsCursor, lastRun, totalMatches
  - ~2s round-trip vs ~80s worker-probe CI cycle
  - No CI overhead, no commit required — direct CF Worker IP call
  - probe_relay_route allow-list extended: /stat/, all /stat/platform/{ats}/status routes

## Current STAT Status (as of session end)
selectmindsCursor: "1122" — advancing correctly from 1000
totalMatches: 0 — Epic IT jobs (~IDs 2000-3000) not yet in scanned range
watchedCompanies: 479, seenJobIds: 757, activeDOs: 112
ETA to Epic IT job range: ~90 min from session end (~cycle 15-25 from cursor 1122)

## How to Check STAT Status Next Session
Use probe_relay_route (no CI overhead):
  /stat/                              → overview
  /stat/platform/selectminds/status   → cursor + totalMatches
  /stat/logs?ats=selectminds&limit=5  → recent alarm activity
stat_status MCP tool available once relay tool cache refreshes.

## Open Items

**Verify:**
- SelectMinds first match — totalMatches > 0 once cursor reaches ~2000-3000 range
- Browse now showing matched jobs (verify in UI after next match)
- polled:1 per SelectMinds alarm cycle (url-keyed dedup fix)

**Carry-forward:**
- #7  Feedback loop — Applied/Skip → Claude review context
- #11 STAT_KV dead binding — wrangler.toml cleanup (3-line remove)
- Tenet Oracle HCM — one html_probe for site ID
- Avature UCSF — one html_probe for feed endpoint
- Taleo tbe.taleo.net (Mount Sinai) — one html_probe
- seen_ids epoch0 migration — entries seenAt epoch0 excluded from 90-day cap? Verify.

## Seed Count
271 seed + manual = 479 total watched, 10 ATS platforms
