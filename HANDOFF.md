# STAT HANDOFF — 2026-06-06

## State
HEAD: f56188c
Smoke: not yet established (smoke.js created this session)

## This Session
Fixed: Browse tab never auto-populating after first poll cycle.

ROOT CAUSE: unmatchedJobs.push() was after the seenIds dedup gate
in both platform-do.js and batch.js. Every job was already in seenIds
on poll 2+, so continue fired before Browse capture was ever reached.
Browse only populated via manual Backfill button.

FIX: Move Browse capture before dedup in both files. Dedup remains
intact for alert path. Capture now runs every alarm cycle automatically.

Added: STANDARDS.md — session discipline, smoke gate rules, dedup rule.
Added: HANDOFF.md — this file.
Added: smoke.js — structural assertions, blocks bad commits.

## Open Items
- Wire smoke.js as pre-commit hook (.git/hooks/pre-commit)
- Browser-verify Browse auto-populates on next alarm cycle
- Verify Refresh button still works as manual fallback
- BY ATS dropdown: confirm ATS labels populate once jobs arrive
- Bootstrap watchers if BY ATS still shows "None loaded" after next poll

## Known State
- 181 companies configured
- 36 jobs seen (all in seenIds before fix landed)
- Active DOs: 8
- Browse: will populate on next alarm cycle (30–120s after deploy)
