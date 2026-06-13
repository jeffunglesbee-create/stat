#!/bin/bash
# STAT Apply Agent — local setup
# Finds the ANTHROPIC_API_KEY automatically, builds profile, installs deps.
# Usage: bash scripts/setup-apply.sh

set -e
cd "$(dirname "$0")/.."

echo "═══ STAT Apply Agent Setup ═══"
echo ""

# ── 1. Find ANTHROPIC_API_KEY ───────────────────────────────────────────────
# Priority: .env file → environment → wrangler (prompt to copy) → Cloudflare API

KEY=""

# Check .env file
if [ -f .env ] && grep -q "ANTHROPIC_API_KEY=" .env 2>/dev/null; then
  KEY=$(grep "ANTHROPIC_API_KEY=" .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  [ -n "$KEY" ] && echo "✓ API key found in .env"
fi

# Check environment
if [ -z "$KEY" ] && [ -n "$ANTHROPIC_API_KEY" ]; then
  KEY="$ANTHROPIC_API_KEY"
  echo "✓ API key found in environment"
fi

# Check ~/.anthropic (some SDK installs store it here)
if [ -z "$KEY" ] && [ -f ~/.anthropic/api_key ]; then
  KEY=$(cat ~/.anthropic/api_key | tr -d '[:space:]')
  [ -n "$KEY" ] && echo "✓ API key found in ~/.anthropic/api_key"
fi

# Try wrangler — can verify secret EXISTS but can't read the value
if [ -z "$KEY" ] && command -v wrangler &>/dev/null; then
  echo ""
  echo "Checking Cloudflare Worker secrets..."
  if wrangler secret list --name stat-job-watcher 2>/dev/null | grep -q "ANTHROPIC_API_KEY"; then
    echo "✓ ANTHROPIC_API_KEY exists on Cloudflare Worker (stat-job-watcher)"
    echo "  → Cloudflare secrets are write-only — can't read the value."
    echo "  → Copy it from your Anthropic dashboard or password manager."
    echo ""
  fi

  # Also check GitHub secrets
  if [ -n "$STAT_PAT" ]; then
    GH_CHECK=$(curl -s -H "Authorization: token $STAT_PAT" \
      https://api.github.com/repos/jeffunglesbee-create/stat/actions/secrets 2>/dev/null)
    if echo "$GH_CHECK" | grep -q "ANTHROPIC_API_KEY"; then
      echo "✓ ANTHROPIC_API_KEY exists as GitHub repo secret"
      echo "  → GitHub secrets are also write-only."
      echo "  → The CI workflow already has it — local needs a copy."
    fi
  fi

  echo ""
  read -rp "Paste your ANTHROPIC_API_KEY: " KEY
fi

# Last resort
if [ -z "$KEY" ]; then
  echo "No API key found in .env, environment, or ~/.anthropic/api_key"
  read -rp "Paste your ANTHROPIC_API_KEY: " KEY
fi

if [ -z "$KEY" ]; then
  echo "✗ No API key provided. Exiting."
  exit 1
fi

# Write to .env (already in .gitignore)
echo "ANTHROPIC_API_KEY=$KEY" > .env
echo "✓ Written to .env"

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
