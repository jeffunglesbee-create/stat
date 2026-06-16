#!/usr/bin/env python3
"""Find HiringCafe's actual search API endpoint by scanning JS bundles."""
import sys, re, urllib.request, urllib.error, json

html_file = sys.argv[1]
with open(html_file, 'r', errors='replace') as f:
    html = f.read()

# Get relative script URLs to fetch
script_srcs = re.findall(r'src=["\'](\/_next\/static\/chunks\/[^"\']+)["\']', html)
print(f"Found {len(script_srcs)} chunk URLs to scan")

# Fetch a few of the smaller chunks looking for API config
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36"

interesting_patterns = [
    r'algolia',
    r'[A-Z0-9]{10}\.algolia',
    r'NEXT_PUBLIC',
    r'apiKey',
    r'appId',
    r'/api/search',
    r'/api/jobs',
    r'elasticsearch',
    r'ELASTIC',
    r'instantsearch',
    r'algoliasearch',
    r'hiring\.cafe/api',
]

scanned = 0
for src in script_srcs[:30]:  # scan first 30 chunks
    url = f"https://hiring.cafe{src}"
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=10) as resp:
            js = resp.read().decode('utf-8', errors='replace')
            scanned += 1
            for pat in interesting_patterns:
                if re.search(pat, js, re.IGNORECASE):
                    # Extract context
                    for m in re.finditer(f'.{{0,80}}{pat}.{{0,80}}', js, re.IGNORECASE):
                        ctx = m.group().strip()
                        print(f"[{src.split('/')[-1][:20]}] PATTERN={pat}: {ctx[:200]}")
                    break
    except Exception as e:
        pass

print(f"\nScanned {scanned} chunks")
