#!/usr/bin/env python3
"""
STAT — HiringCafe company harvest
Scrapes HiringCafe across Epic/health-IT search terms.
Extracts company + ATS token/URL for companies not already in config.js
Writes results to outbox/hc-harvest-result.json
"""
import urllib.request, urllib.parse, json, re, time, os, sys

SEARCH_TERMS = [
    'epic analyst', 'epic ambulatory', 'epic application analyst',
    'ehr analyst', 'ehr application analyst', 'clarity sql',
    'epic implementation', 'epic consultant', 'epic inpatient',
    'clinical informatics analyst', 'healthcare it analyst',
    'health informatics analyst', 'epic cadence', 'epic resolute',
    'epic beacon', 'epic radiant', 'epic willow', 'epic optime',
    'epic training analyst', 'epic build analyst', 'epic go live',
    'cerner analyst', 'meditech analyst',
    'health information management', 'revenue cycle analyst remote',
    'remote customer service', 'remote customer success',
    'remote logistics coordinator', 'remote supply chain analyst',
    'remote data analyst healthcare', 'remote sql analyst',
]
ENVIRONMENTS = ['remote', 'hybrid']

ATS_SOURCE_MAP = {
    'greenhouse': 'greenhouse', 'lever': 'lever', 'ashby': 'ashby',
    'workday': 'workday', 'icims': 'icims', 'icims2': 'icims',
    'successfactors': 'successfactors', 'taleo': 'taleo',
}

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
}

def fetch_hc(term, env):
    url = 'https://hiring.cafe/?q=' + urllib.parse.quote(term) + '&workplace_type=' + env
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=20) as r:
            html = r.read().decode('utf-8', errors='ignore')
    except Exception as e:
        print('  FETCH ERROR ' + term + '/' + env + ': ' + str(e), file=sys.stderr)
        return []

    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        return []
    try:
        raw_str = json.dumps(json.loads(m.group(1)))
    except:
        return []

    jobs = []
    job_blocks = re.findall(r'\{[^{}]{20,2000}\}', raw_str)
    for block in job_blocks:
        co_m = re.search(r'"company_name"\s*:\s*"([^"]+)"', block)
        tk_m = re.search(r'"board_token"\s*:\s*"([^"]+)"', block)
        sr_m = re.search(r'"source"\s*:\s*"([^"]+)"', block)
        au_m = re.search(r'"apply_url"\s*:\s*"(https://[^"]+)"', block)

        if co_m and sr_m:
            company = co_m.group(1).strip()
            source  = sr_m.group(1).lower()
            ats     = ATS_SOURCE_MAP.get(source)
            if not ats:
                continue
            token = None
            if tk_m:
                token = tk_m.group(1).strip()
            elif au_m:
                token = au_m.group(1).strip()
            if token:
                jobs.append({'company': company, 'ats': ats, 'token': token})

    for m2 in re.finditer(r'"company_name"\s*:\s*"([^"]+)"[^}]{0,500}"apply_url"\s*:\s*"(https://[^"]*myworkdayjobs[^"]*)"', raw_str, re.S):
        jobs.append({'company': m2.group(1).strip(), 'ats': 'workday', 'token': m2.group(2).strip()})

    return jobs

config_text = open('src/config.js').read()
known_names  = set(m.lower().strip() for m in re.findall(r"name:\s*'([^']+)'", config_text))
known_tokens = set(m.lower().strip() for m in re.findall(r"token:\s*'([^']+)'", config_text))
known_urls   = set(m.lower().strip() for m in re.findall(r"url:\s*'([^']+)'", config_text))

discovered = {}
total = 0

for i, term in enumerate(SEARCH_TERMS):
    for env in ENVIRONMENTS:
        jobs = fetch_hc(term, env)
        total += 1
        for j in jobs:
            company, token, ats = j['company'], j['token'], j['ats']
            if company.lower() in known_names: continue
            if token.lower() in known_tokens:  continue
            if token.lower() in known_urls:    continue
            if len(company) < 3 or len(token) < 3: continue
            key = ats + ':' + token.lower()
            if key not in discovered:
                discovered[key] = {'company': company, 'ats': ats, 'token': token, 'hits': 0}
            discovered[key]['hits'] += 1
        time.sleep(0.5)
    if (i + 1) % 5 == 0:
        print(str(i+1) + '/' + str(len(SEARCH_TERMS)) + ' terms, ' + str(len(discovered)) + ' new companies')

results = sorted(discovered.values(), key=lambda x: (x['ats'], x['company'].lower()))

os.makedirs('outbox', exist_ok=True)
with open('outbox/hc-harvest-result.json', 'w') as f:
    json.dump({'total_calls': total, 'count': len(results), 'companies': results}, f, indent=2)

by_ats = {}
for r in results:
    by_ats.setdefault(r['ats'], []).append(r['company'])

print('Total calls: ' + str(total) + ' | New companies: ' + str(len(results)))
for ats, cos in sorted(by_ats.items()):
    print('  ' + ats.ljust(20) + str(len(cos)).rjust(3) + '  ' + ', '.join(cos[:5]))
