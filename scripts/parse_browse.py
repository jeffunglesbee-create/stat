#!/usr/bin/env python3
"""Parse /browse or /jobs response — show job titles, companies, ATS source."""
import sys, json
try:
    data = json.load(sys.stdin)
    jobs = data if isinstance(data, list) else data.get('jobs', data.get('results', []))
    print(f'Total: {len(jobs)}')
    for j in jobs[:15]:
        title = j.get('title', '?') or '(no title)'
        company = j.get('company', '?')
        ats = j.get('atsSource', '?')
        env = j.get('environment', '')
        print(f'  [{ats}] {title} @ {company}  env={env}')
except Exception as e:
    raw = sys.stdin.read() if hasattr(sys.stdin, 'read') else ''
    print(f'error: {e}')
