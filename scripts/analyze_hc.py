#!/usr/bin/env python3
"""Analyze HiringCafe __NEXT_DATA__ — full Algolia credential extraction."""
import sys, json, re

with open(sys.argv[1], 'r', errors='replace') as f:
    html = f.read()

# First: check for Algolia credentials embedded in script tags directly
# (sometimes separate from __NEXT_DATA__)
algolia_patterns = [
    r'["\']([A-Z0-9]{10})["\']',  # app ID pattern
    r'algolia.*?appId["\']?\s*[:=]\s*["\']([^"\']+)',
    r'ALGOLIA_APP_ID["\']?\s*[:=]\s*["\']([^"\']+)',
    r'applicationId["\']?\s*:\s*["\']([^"\']+)',
]
print("=== Scanning HTML for Algolia credentials ===")
for script_m in re.finditer(r'<script[^>]*>([\s\S]*?)</script>', html):
    script = script_m.group(1)
    if 'algolia' in script.lower() or 'instantsearch' in script.lower():
        print(f"Script with algolia ref (first 300): {script[:300]}")

# Extract __NEXT_DATA__
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

print("\n=== pageProps keys ===")
print(list(pp.keys()))

print("\n=== initialSearchState FULL DUMP ===")
iss = pp.get('initialSearchState', {})
print(json.dumps(iss, indent=2)[:3000])

print("\n=== ssrTimings ===")
print(json.dumps(pp.get('ssrTimings', {}), indent=2)[:500])

# Also check runtimeConfig / publicRuntimeConfig
print("\n=== runtimeConfig / publicRuntimeConfig ===")
rc = data.get('runtimeConfig', {})
prc = data.get('publicRuntimeConfig', {})
if rc: print("runtimeConfig:", json.dumps(rc, indent=2)[:1000])
if prc: print("publicRuntimeConfig:", json.dumps(prc, indent=2)[:1000])

# Look for Algolia config in the broader data structure
print("\n=== Full data keys ===")
print(list(data.keys()))

# Check if there's an env or config block
for key in ['env', 'config', 'query', 'buildId']:
    val = data.get(key)
    if val is not None:
        print(f"data.{key}: {str(val)[:300]}")
