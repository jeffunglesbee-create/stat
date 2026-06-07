#!/usr/bin/env python3
"""Find Algolia credentials in HiringCafe JS bundles."""
import sys, re, urllib.request, urllib.error

html_file = sys.argv[1]
with open(html_file, 'r', errors='replace') as f:
    html = f.read()

# Extract all script src URLs
script_srcs = re.findall(r'<script[^>]+src=["\']([^"\']+)["\']', html)
print(f"Found {len(script_srcs)} script srcs:")
for s in script_srcs[:20]:
    print(f"  {s}")

# Also look for inline Algolia references in the HTML itself
algolia_refs = re.findall(r'[A-Z0-9]{10}\.algolia(?:net|\.net)', html)
if algolia_refs:
    print(f"\nAlgolia app ID refs in HTML: {algolia_refs}")

# Check for NEXT_PUBLIC_ env vars in the page source
public_vars = re.findall(r'NEXT_PUBLIC_[A-Z_]+["\']?\s*[:=]\s*["\']([^"\']{3,50})', html)
if public_vars:
    print(f"\nNEXT_PUBLIC vars: {public_vars}")

# Look for instantsearch or algoliasearch references
if 'algoliasearch' in html or 'instantsearch' in html:
    print("\nAlgolia client lib reference found in HTML")
    # Extract context
    for m in re.finditer(r'.{0,50}(?:algoliasearch|instantsearch).{0,50}', html):
        print(f"  {m.group()}")

# The search API might be their own /api/search endpoint on hiring.cafe
# Check for fetch('/api/...) or similar in script content
api_patterns = re.findall(r'fetch\(["\']([^"\']*api[^"\']*)["\']', html)
if api_patterns:
    print(f"\nfetch() API patterns: {api_patterns[:10]}")

# Check for direct ES endpoint references
es_patterns = re.findall(r'https?://[^\s"\']*(?:elasticsearch|elastic|es\.)[^\s"\']*', html)
if es_patterns:
    print(f"\nElasticsearch endpoint refs: {es_patterns[:5]}")
