#!/usr/bin/env python3
"""Analyze a HiringCafe job detail page for description and NEXT_DATA structure."""
import sys, json, re

with open(sys.argv[1], 'r', errors='replace') as f:
    html = f.read()

# og: tags
for tag in ['og:title', 'og:description', 'description']:
    m = re.search(r'<meta[^>]+(?:name|property)=["\']' + tag + r'["\'][^>]+content=["\']([^"\']+)', html)
    if not m:
        m = re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:name|property)=["\']' + tag + r'["\']', html)
    print(f'{tag}: {m.group(1)[:300] if m else "NOT FOUND"}')

# NEXT_DATA
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
print(f'\npageProps keys: {list(pp.keys())}')

for k, v in pp.items():
    if isinstance(v, dict):
        print(f'\npp.{k} (dict, {len(v)} keys: {list(v.keys())[:20]}):')
        for subk, subv in v.items():
            if subk not in ('_geoloc',):
                sv = repr(subv)
                print(f'  .{subk}: {sv[:250]}')
    elif isinstance(v, list) and v:
        print(f'pp.{k}: list of {len(v)} items')
    elif v is not None:
        print(f'pp.{k}: {repr(v)[:200]}')

# JSON-LD
for ld in re.findall(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>([\s\S]*?)</script>', html):
    try:
        obj = json.loads(ld)
        print(f'\nJSON-LD: {json.dumps(obj, indent=2)[:800]}')
    except Exception:
        pass
