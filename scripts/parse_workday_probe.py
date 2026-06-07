#!/usr/bin/env python3
"""Parse STAT /workday-probe JSON from stdin and print results table."""
import sys, json
try:
    d = json.load(sys.stdin)
    print('anyThrottle:', d['anyThrottle'])
    print('lowestSafeGap:', d['lowestSafeGapSeconds'], 's')
    for r in d['results']:
        elapsed = f"  {r['elapsed']}ms" if 'elapsed' in r else ''
        print(f"  gap={r['gap']:2d}s  HTTP={r['http']}  jobs={r['jobs']}{elapsed}  [{r['verdict']}]")
except Exception as e:
    print('PARSE ERROR:', e)
