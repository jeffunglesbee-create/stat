"""
STAT Apply Agent — browser-use prototype
Navigates to a job application page and fills the form using an LLM agent.

Usage:
  python scripts/apply-agent.py --url "https://careers-mdmercy.icims.com/jobs/13529/epic-willow-ambulatory-analyst"
  python scripts/apply-agent.py --url "..." --dry-run   # fill but don't submit

Requires:
  pip install browser-use playwright
  playwright install chromium
  ANTHROPIC_API_KEY or GOOGLE_API_KEY in environment

Architecture:
  STAT already handles discovery, enrichment, scoring, and fit review.
  This script handles the LAST MILE: navigating the employer's career site
  and submitting the application. The LLM agent sees the page, identifies
  form fields, fills them with profile data, uploads the resume, answers
  screening questions, and clicks submit.

  No per-ATS selectors needed — the agent handles iCIMS, Workday,
  Greenhouse, Lever, Taleo, or any other form dynamically.
"""

import asyncio
import json
import os
import sys
import argparse

# Auto-load .env if present (ANTHROPIC_API_KEY, etc.)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# browser-use handles the LLM ↔ browser bridge
from browser_use import Agent
from browser_use.browser.browser import Browser, BrowserConfig


def load_profile():
    """Load candidate profile from STAT's stored profile or a local file."""
    # Check for STAT profile file (exported from /ui Resume tab)
    paths = [
        'data/profile.json',
        os.path.expanduser('~/.stat/profile.json'),
    ]
    for p in paths:
        if os.path.exists(p):
            with open(p) as f:
                return json.load(f)

    # Fallback: build from environment variables
    return {
        'name':          os.environ.get('APPLICANT_NAME', 'Jeffrey Unglesbee'),
        'email':         os.environ.get('APPLICANT_EMAIL', ''),
        'phone':         os.environ.get('APPLICANT_PHONE', ''),
        'location':      os.environ.get('APPLICANT_LOCATION', 'Baltimore, MD'),
        'current_title': os.environ.get('APPLICANT_TITLE', 'Epic Systems Analyst'),
        'resume_path':   os.environ.get('RESUME_PATH', 'data/resume.pdf'),
    }


def build_task(url, profile, dry_run=False):
    """Build the agent task prompt."""
    submit_instruction = (
        "DO NOT click Submit/Send/Apply at the final step. Stop before submission and report what you filled."
        if dry_run else
        "Submit the application after filling all required fields."
    )

    skills = profile.get('skills', [])
    skills_str = ', '.join(skills) if skills else 'Epic Systems, Clinical Informatics, Healthcare IT'

    return f"""
You are applying for a job. Navigate to the application page and complete the form.

JOB URL: {url}

CANDIDATE PROFILE:
  Full Name: {profile.get('name', 'Jeffrey Unglesbee')}
  Email: {profile.get('email', '')}
  Phone: {profile.get('phone', '')}
  Location: {profile.get('location', 'Baltimore, MD')}
  Current Title: {profile.get('current_title', 'Epic Systems Analyst')}
  Key Skills: {skills_str}

RESUME FILE: {profile.get('resume_path', 'data/resume.pdf')}

INSTRUCTIONS:
1. Go to the job URL.
2. If there is a login/register page, look for "Apply" or "Apply Now" button first.
   If login is required, use the candidate's email to register or log in.
3. Fill all required form fields using the candidate profile.
4. Upload the resume file if there is a file upload field.
5. For screening questions you're unsure about, choose the most reasonable answer
   for a healthcare IT professional with 3+ years of Epic Systems experience
   (Ambulatory/EpicCare module). Answer "Yes" to Epic certification questions.
   For years of experience with Epic, answer "3" or "3-5" depending on the options.
6. Accept any privacy policy or terms if required.
7. {submit_instruction}

IMPORTANT:
- If the form is inside an iframe, navigate into it.
- If there are multiple steps/pages, complete each one.
- If you encounter a CAPTCHA, stop and report it.
- Take screenshots at each major step for verification.
"""


async def run_apply(url, dry_run=False, model='anthropic'):
    """Run the browser-use apply agent."""
    profile = load_profile()

    if not profile.get('email'):
        print("ERROR: No email in profile. Run setup first:")
        print("  bash scripts/setup-apply.sh")
        sys.exit(1)

    task = build_task(url, profile, dry_run)

    # Configure browser
    browser = Browser(
        config=BrowserConfig(
            headless=True,  # CI-compatible
        )
    )

    # ── LLM routing ──────────────────────────────────────────────────────────
    # FIELD already solved API key distribution: field-claude-proxy Worker
    # holds ANTHROPIC_KEY and accepts server-to-server requests via
    # X-FIELD-Relay header bypass. No local API key needed.
    #
    # Priority:
    #   1. Local ANTHROPIC_API_KEY (if set — direct to Anthropic)
    #   2. field-claude-proxy (no key needed — relay header auth)
    #   3. GOOGLE_API_KEY (Gemini fallback)
    PROXY_URL = 'https://field-claude-proxy.jeffunglesbee.workers.dev'
    RELAY_HEADER = os.environ.get('FIELD_RELAY_SECRET', 'field-relay-cron-2026')

    if os.environ.get('ANTHROPIC_API_KEY'):
        from langchain_anthropic import ChatAnthropic
        llm = ChatAnthropic(model='claude-sonnet-4-20250514', timeout=60)
        print("LLM: Anthropic direct")
    elif os.environ.get('GOOGLE_API_KEY'):
        from langchain_google_genai import ChatGoogleGenerativeAI
        llm = ChatGoogleGenerativeAI(model='gemini-2.0-flash')
        print("LLM: Google Gemini")
    else:
        # Route through field-claude-proxy — no local key needed
        from langchain_anthropic import ChatAnthropic
        llm = ChatAnthropic(
            model='claude-sonnet-4-20250514',
            anthropic_api_key='proxy-auth',  # not used — proxy has its own key
            base_url=PROXY_URL,
            default_headers={
                'X-FIELD-Relay': RELAY_HEADER,
                'X-FIELD-Force-Claude': 'true',  # bypass Gemini — agent needs multi-turn
            },
            timeout=60,
        )
        print(f"LLM: Anthropic via field-claude-proxy")

    agent = Agent(
        task=task,
        llm=llm,
        browser=browser,
        max_actions_per_step=5,
    )

    print(f"{'[DRY RUN] ' if dry_run else ''}Applying to: {url}")
    print(f"Candidate: {profile.get('name')}")
    print()

    result = await agent.run(max_steps=30)

    print("\n=== AGENT RESULT ===")
    print(result)

    await browser.close()
    return result


def main():
    parser = argparse.ArgumentParser(description='STAT Apply Agent')
    parser.add_argument('--url', required=True, help='Job application URL')
    parser.add_argument('--dry-run', action='store_true',
                        help='Fill form without submitting')
    parser.add_argument('--model', default='anthropic',
                        choices=['anthropic', 'google'],
                        help='LLM provider')
    args = parser.parse_args()

    asyncio.run(run_apply(args.url, args.dry_run, args.model))


if __name__ == '__main__':
    main()
