#!/bin/bash
# STAT Apply Agent — local setup
# Finds the ANTHROPIC_API_KEY automatically, builds profile, installs deps.
# Usage: bash scripts/setup-apply.sh

set -e
cd "$(dirname "$0")/.."

echo "═══ STAT Apply Agent Setup ═══"
echo ""

# ── 1. API Key — handled by field-claude-proxy ──────────────────────────────
# No local ANTHROPIC_API_KEY needed. The apply agent routes through
# field-claude-proxy.jeffunglesbee.workers.dev which holds the key.
# Server-to-server auth via X-FIELD-Relay header (same pattern as FIELD cron).
echo "✓ API key: routed through field-claude-proxy (no local key needed)"

# ── 2. Build profile ────────────────────────────────────────────────────────
mkdir -p data

if [ -f data/profile.json ]; then
  echo "✓ data/profile.json already exists"
else
  echo ""
  echo "Building candidate profile..."
  echo "(Press Enter to accept defaults, or type to override)"
  echo ""

  read -rp "Full name [Jeffrey Unglesbee]: " NAME
  NAME="${NAME:-Jeffrey Unglesbee}"

  read -rp "Email: " EMAIL
  read -rp "Phone: " PHONE

  read -rp "Location [Baltimore, MD]: " LOCATION
  LOCATION="${LOCATION:-Baltimore, MD}"

  read -rp "Current title [Epic Systems Analyst]: " TITLE
  TITLE="${TITLE:-Epic Systems Analyst}"

  read -rp "Resume path [data/resume.pdf]: " RESUME
  RESUME="${RESUME:-data/resume.pdf}"

  cat > data/profile.json << PROFILE
{
  "name": "$NAME",
  "email": "$EMAIL",
  "phone": "$PHONE",
  "location": "$LOCATION",
  "current_title": "$TITLE",
  "resume_path": "$RESUME",
  "skills": [
    "Epic Systems (Ambulatory/EpicCare)",
    "Clinical Informatics",
    "Healthcare IT",
    "System Analysis",
    "HL7/FHIR",
    "Data Analysis"
  ]
}
PROFILE

  echo "✓ Profile saved to data/profile.json"
fi

# ── 3. Check resume ─────────────────────────────────────────────────────────
RESUME_PATH=$(python3 -c "import json; print(json.load(open('data/profile.json')).get('resume_path','data/resume.pdf'))" 2>/dev/null || echo "data/resume.pdf")

if [ -f "$RESUME_PATH" ]; then
  echo "✓ Resume found: $RESUME_PATH"
else
  echo ""
  echo "⚠ No resume at $RESUME_PATH"
  echo "  Place your resume PDF there before running the agent."
fi

# ── 4. Install dependencies ─────────────────────────────────────────────────
echo ""
echo "Installing dependencies..."
pip install browser-use playwright langchain-anthropic python-dotenv 2>/dev/null | tail -2
playwright install chromium 2>/dev/null | tail -1
echo "✓ Dependencies installed"

# ── 5. Ready ────────────────────────────────────────────────────────────────
echo ""
echo "═══ Setup complete ═══"
echo ""
echo "Dry-run test (fill form, don't submit):"
echo "  python scripts/apply-agent.py \\"
echo "    --url 'https://risanthealth.wd503.myworkdayjobs.com/gbl/job/Headquarters/Clinical-Informatics-Epic-Analyst_R-0001192' \\"
echo "    --dry-run"
echo ""
echo "Live apply:"
echo "  python scripts/apply-agent.py \\"
echo "    --url '<job-url>'"
