#!/usr/bin/env python3
"""Analyze a HiringCafe HTML response file for __NEXT_DATA__ job structure."""
import sys, json, re

with open(sys.argv[1], 'r', errors='replace') as f:
    html = f.read()

m = re.search(r'<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)</script>', html)
if not m:
    print('__NEXT_DATA__: NOT FOUND')
    sys.exit(0)

try:
    data = json.loads(m.group(1))
except Exception as e:
    print(f'JSON parse error: {e}')
    sys.exit(0)

pp = data.get('props', {}).get('pageProps', {})
print(f'pageProps keys: {list(pp.keys())[:20]}')

jobs = None
jobs_key = None
for k in ['jobs', 'jobListings', 'results']:
    v = pp.get(k)
    if isinstance(v, list) and v:
        jobs, jobs_key = v, k
        break
    elif isinstance(v, dict) and v.get('jobs'):
        jobs, jobs_key = v['jobs'], f'{k}.jobs'
        break

if not jobs:
    print('No jobs found in any key')
    sys.exit(0)

print(f'jobs: pp.{jobs_key} — {len(jobs)} items')
j = jobs[0]
print(f'top-level keys: {list(j.keys())[:25]}')

inf = j.get('job_information', {})
v5  = j.get('v5_processed_job_data', {})

print(f'job_information present: {bool(inf)}, keys: {list(inf.keys())[:15]}')
print(f'v5_processed_job_data present: {bool(v5)}')

title   = inf.get('title') or inf.get('job_title_raw') or j.get('title', '?')
company = (j.get('enriched_company_data') or {}).get('name') or j.get('companyName', '?')
print(f'title: {title}')
print(f'company: {company}')
print(f'source: {j.get("source")}  board_token: {j.get("board_token")}')
print(f'apply_url: {j.get("apply_url") or j.get("applicationUrl") or j.get("applyUrl")}')

desc = inf.get('description') or inf.get('descriptionHtml') or ''
print(f'description: present={bool(desc)} len={len(desc)}')

if v5:
    print(f'v5 keys: {list(v5.keys())[:25]}')
    for field in ['workplace_type','workplace_states','boundless_workplace_states',
                  'is_workplace_worldwide_ok','yearly_min_compensation','yearly_max_compensation',
                  'seniority_level','requirements_summary','estimated_publish_date',
                  'technical_tools','licenses_or_certifications','visa_sponsorship',
                  'min_industry_and_role_yoe','is_compensation_transparent']:
        val = v5.get(field)
        if val is not None:
            display = str(val[:3]) if isinstance(val, list) else str(val)[:80]
            print(f'  v5.{field}: {display}')

print('Sample jobs:')
for jj in jobs[:8]:
    ii = jj.get('job_information', {})
    vv = jj.get('v5_processed_job_data', {})
    t  = (ii.get('title') or ii.get('job_title_raw') or jj.get('title','?'))[:55]
    c  = ((jj.get('enriched_company_data') or {}).get('name') or jj.get('companyName','?'))[:35]
    e  = vv.get('workplace_type','?')
    s  = jj.get('source','?')
    print(f'  [{e}|{s}] {t} @ {c}')
