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
print(f'pageProps keys: {list(pp.keys())}')

# Check ssrHits — the new key
ssr_hits = pp.get('ssrHits')
print(f'ssrHits type: {type(ssr_hits).__name__}')
print(f'ssrTotalCount: {pp.get("ssrTotalCount")}')
print(f'ssrPageSize: {pp.get("ssrPageSize")}')
print(f'ssrError: {pp.get("ssrError")}')

if isinstance(ssr_hits, list):
    print(f'ssrHits: list of {len(ssr_hits)} items')
    if ssr_hits:
        j = ssr_hits[0]
        print(f'First hit keys: {list(j.keys())[:30]}')
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
            print(f'v5 keys: {list(v5.keys())[:30]}')
            for field in ['workplace_type','workplace_states','boundless_workplace_states',
                          'is_workplace_worldwide_ok','yearly_min_compensation','yearly_max_compensation',
                          'seniority_level','requirements_summary','estimated_publish_date',
                          'technical_tools','licenses_or_certifications','visa_sponsorship',
                          'min_industry_and_role_yoe','is_compensation_transparent']:
                val = v5.get(field)
                if val is not None:
                    display = str(val[:3]) if isinstance(val, list) else str(val)[:80]
                    print(f'  v5.{field}: {display}')
        print('Sample hits:')
        for jj in ssr_hits[:8]:
            ii = jj.get('job_information', {})
            vv = jj.get('v5_processed_job_data', {})
            t  = (ii.get('title') or ii.get('job_title_raw') or jj.get('title','?'))[:55]
            c  = ((jj.get('enriched_company_data') or {}).get('name') or jj.get('companyName','?'))[:35]
            e  = vv.get('workplace_type','?')
            s  = jj.get('source','?')
            print(f'  [{e}|{s}] {t} @ {c}')
elif isinstance(ssr_hits, dict):
    print(f'ssrHits dict keys: {list(ssr_hits.keys())[:20]}')
    hits = ssr_hits.get('hits', ssr_hits.get('items', []))
    print(f'inner hits: {len(hits)} items')
    if hits:
        j = hits[0]
        print(f'First hit keys: {list(j.keys())[:25]}')
else:
    print(f'ssrHits unexpected type: {ssr_hits}')

# Also check initialSearchState
iss = pp.get('initialSearchState', {})
if iss:
    print(f'\ninitialSearchState keys: {list(iss.keys())[:15]}')
    for k in ['hits', 'jobs', 'results', 'items']:
        v = iss.get(k)
        if v is not None:
            print(f'  initialSearchState.{k}: type={type(v).__name__}, len={len(v) if isinstance(v,(list,dict)) else "n/a"}')
