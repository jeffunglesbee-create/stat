#!/usr/bin/env python3
"""Parse Workday JSON API response from /tmp/wd_resp.json"""
import sys, json
try:
    with open('/tmp/wd_resp.json') as f:
        d = json.load(f)
    jobs = d.get('jobPostings', [])
    print(f'jobPostings count: {len(jobs)}')
    for j in jobs[:3]:
        print(f'  title: {j.get("title","?")} | location: {j.get("locationsText","?")}')
except Exception as e:
    try:
        with open('/tmp/wd_resp.json') as f:
            body = f.read(300)
        print(f'parse error: {e}')
        print(f'body: {body}')
    except:
        print(f'error: {e}')
