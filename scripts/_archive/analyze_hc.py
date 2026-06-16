#!/usr/bin/env python3
"""Analyze HiringCafe __NEXT_DATA__ — full structure dump."""
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
jobs = pp.get('ssrHits', [])
print(f'ssrHits: {len(jobs)} jobs')

if not jobs:
    sys.exit(0)

j = jobs[0]
print(f'\nFirst job full key:value pairs:')
for k, v in j.items():
    if k not in ('job_information', 'v5_processed_job_data', 'enriched_company_data', '_geoloc'):
        print(f'  {k}: {repr(v)[:120]}')

inf = j.get('job_information', {})
v5 = j.get('v5_processed_job_data', {})
print(f'\njob_information: {inf}')
print(f'\nv5.workplace_type: {v5.get("workplace_type")}')
print(f'v5.workplace_states: {v5.get("workplace_states")}')
print(f'v5.yearly_min_compensation: {v5.get("yearly_min_compensation")}')
print(f'v5.estimated_publish_date: {v5.get("estimated_publish_date")}')

print(f'\nSample jobs (id, objectID, source, title, apply_url):')
for jj in jobs[:10]:
    ii = jj.get('job_information', {})
    t = ii.get('title') or ii.get('job_title_raw') or '?'
    print(f'  id={jj.get("id")!r} objectID={jj.get("objectID")!r}')
    print(f'    source={jj.get("source")} board_token={jj.get("board_token","")[:20]}')
    print(f'    title={t[:60]}')
    print(f'    apply_url={jj.get("apply_url","")[:80]}')
