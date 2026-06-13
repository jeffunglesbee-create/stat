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
        'name':       os.environ.get('APPLICANT_NAME', ''),
        'email':      os.environ.get('APPLICANT_EMAIL', ''),
        'phone':      os.environ.get('APPLICANT_PHONE', ''),
        'location':   os.environ.get('APPLICANT_LOCATION', ''),
        'resume_path': os.environ.get('RESUME_PATH', 'data/resume.pdf'),
    }


def build_task(url, profile, dry_run=False):
    """Build the agent task prompt."""
    submit_instruction = (
        "DO NOT click Submit/Send/Apply at the final step. Stop before submission and report what you filled."
        if dry_run else
        "Submit the application after filling all required fields."
    )

    return f"""
You are applying for a job. Navigate to the application page and complete the form.

JOB URL: {url}

CANDIDATE PROFILE:
  Name: {profile.get('name', '')}
  Email: {profile.get('email', '')}
  Phone: {profile.get('phone', '')}
  Location: {profile.get('location', '')}

RESUME FILE: {profile.get('resume_path', 'data/resume.pdf')}

INSTRUCTIONS:
1. Go to the job URL.
2. If there is a login/register page, look for "Apply" or "Apply Now" button first.
   If login is required, use the candidate's email to register or log in.
3. Fill all required form fields using the candidate profile.
4. Upload the resume file if there is a file upload field.
5. For screening questions you're unsure about, choose the most reasonable answer
   for a healthcare IT / Epic analyst candidate.
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

    if not profile.get('name'):
        print("ERROR: No candidate profile found.")
        print("Create data/profile.json or set APPLICANT_NAME env var.")
        sys.exit(1)

    task = build_task(url, profile, dry_run)

    # Configure browser
    browser = Browser(
        config=BrowserConfig(
            headless=True,  # CI-compatible
        )
    )

    # Select LLM based on available API key
    if os.environ.get('ANTHROPIC_API_KEY'):
        from langchain_anthropic import ChatAnthropic
        llm = ChatAnthropic(model='claude-sonnet-4-20250514', timeout=60)
    elif os.environ.get('GOOGLE_API_KEY'):
        from langchain_google_genai import ChatGoogleGenerativeAI
        llm = ChatGoogleGenerativeAI(model='gemini-2.0-flash')
    else:
        print("ERROR: Set ANTHROPIC_API_KEY or GOOGLE_API_KEY")
        sys.exit(1)

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
