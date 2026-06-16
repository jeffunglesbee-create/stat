#!/bin/bash
# STAT SessionStart hook — runs automatically at the start of every Claude Code session.
# Prints project state, runs smoke, and reminds about governance docs.

echo "🔧 STAT SessionStart hook running..."

# Print HANDOFF.md state
echo ""
echo "📋 HANDOFF.md state:"
head -20 HANDOFF.md 2>/dev/null || echo "  (HANDOFF.md not found — check docs/STAT-SNAPSHOT.txt)"

# Run smoke and print count
echo ""
echo "🔍 Smoke check:"
SMOKE_OUT=$(node smoke.js 2>&1 | tail -1)
echo "  $SMOKE_OUT"

# Check for uncommitted changes
echo ""
DIRTY=$(git status --porcelain 2>/dev/null | wc -l)
if [ "$DIRTY" -gt 0 ]; then
  echo "⚠️  $DIRTY uncommitted changes"
else
  echo "✅ Working tree clean"
fi

# Remind about governance docs
echo ""
echo "📝 Before starting work:"
echo "  - Read HANDOFF.md for current state and open items"
echo "  - Read docs/STAT-CLAUDE-REVIEW.txt before UI changes"
echo "  - Read docs/STAT-COMMITMENTS.txt for architectural constraints"
echo "  - Declare session type: A (adapter) / B (bugfix) / C (feature) / D (audit)"

echo ""
echo "✅ SessionStart hook complete"
