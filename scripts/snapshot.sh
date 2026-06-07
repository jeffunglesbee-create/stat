#!/usr/bin/env bash
# scripts/snapshot.sh
# Generates docs/STAT-SNAPSHOT.txt
# Called by .github/workflows/doc-snapshot.yml
# No heredocs, no multiline python3 -c — both break YAML block scalars.
set -euo pipefail

mkdir -p docs

HEAD=$(git rev-parse --short HEAD)
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# ── Company counts (python3 reads the file with real newlines — no YAML issue) ──
SEED_GH=$(python3 scripts/snapshot.py greenhouse)
SEED_WD=$(python3 scripts/snapshot.py workday)
SEED_TOTAL=$(python3 scripts/snapshot.py seed_total)
BATCH_TOTAL=$(python3 scripts/snapshot.py batch_total)
BATCH_CPL=$(python3 scripts/snapshot.py batch_cpl)

# ── Smoke ───────────────────────────────────────────────────────────────────────
SMOKE_LINE=$(node smoke.js 2>&1 | grep -oP '\d+/\d+(?= passed)' | head -1 || echo "?/?")

# ── Recent commits (skip [skip ci] noise) ──────────────────────────────────────
COMMITS=$(git log --oneline -10 | grep -v '\[skip ci\]' | head -5 | sed 's/^/  /')

# ── Write output ────────────────────────────────────────────────────────────────
{
  printf 'STAT - Auto-generated Snapshot\n'
  printf 'Generated: %s\n' "$TIMESTAMP"
  printf 'HEAD: %s\n' "$HEAD"
  printf 'Smoke: %s\n' "$SMOKE_LINE"
  printf '\n'
  printf 'COMPANIES\n'
  printf '  SEED total: %s\n' "$SEED_TOTAL"
  printf "  Workday: %s (searchText: 'epic ehr within')\n" "$SEED_WD"
  printf '  Greenhouse: %s\n' "$SEED_GH"
  printf '\n'
  printf 'RECENT COMMITS\n'
  printf '%s\n' "$COMMITS"
  printf '\n'
  printf 'POLLING LAYERS\n'
  printf '  1. HiringCafe: 1-min cron, time-aware adaptive backoff, BR + SSR fallback\n'
  printf '  2. Platform DOs: 7 DOs, CHUNK_SIZE=15, cursor rotation\n'
  printf '     Workday sweep (%s cos): ~24min | GH sweep (%s cos): ~8min\n' "$SEED_WD" "$SEED_GH"
  printf '  3. BatchPollerDO: %s cos, %s/cycle, 2min interval\n' "$BATCH_TOTAL" "$BATCH_CPL"
  printf '  4. Backfill: manual POST /backfill-browse\n'
  printf '\n'
  printf 'KEY FACTS (do not re-verify)\n'
  printf '  HiringCafe: Elasticsearch backend (NOT Algolia), private VPC\n'
  printf '  ?q= param: server-side no-op, returns same 152 jobs always\n'
  printf '  DO alarm limit: 30s wall-clock (network I/O excluded)\n'
  printf '  Cache-Control: no-store on /ui (Safari cache busted)\n'
  printf '  PAT: STAT-TOKEN fine-grained, stat repo only, expires Jun 7 2027\n'
  printf '\n'
  printf 'DRIVE DOCUMENT IDs\n'
  printf '  Current State:  1uncfMyzp0TG1FiydoEcZX2aiq8EPhGcF\n'
  printf '  Session 3 Doc:  1tRyd03iYCFaLn73IRCjQfOFjCHyGIFcMEKXCKuPDgIo\n'
  printf '  Build Backlog:  1ugUh6UmeDkLR-gEH8hJPwXK2NiIrXYQY8gp2jO2p2Hk\n'
} > docs/STAT-SNAPSHOT.txt

echo "Snapshot written: docs/STAT-SNAPSHOT.txt"
cat docs/STAT-SNAPSHOT.txt
