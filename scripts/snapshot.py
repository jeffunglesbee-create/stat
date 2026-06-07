#!/usr/bin/env python3
"""
scripts/snapshot.py
Reads src/config.js and returns a single metric as a string.
Called by scripts/snapshot.sh — one metric per invocation avoids
any shell-escaping complexity.

Usage: python3 scripts/snapshot.py <metric>
Metrics: greenhouse, workday, seed_total, batch_total, batch_cpl
"""
import sys
import re

def read_config():
    with open('src/config.js', 'r') as f:
        return f.read()

def main():
    if len(sys.argv) < 2:
        print("?")
        sys.exit(1)

    metric = sys.argv[1]
    content = read_config()

    # Boundary between SEED_COMPANIES and BATCH_WATCHLIST
    seed_start = content.find('export const SEED_COMPANIES')
    batch_start = content.find('export const BATCH_WATCHLIST')

    if seed_start == -1 or batch_start == -1:
        print("?")
        sys.exit(1)

    seed_section = content[seed_start:batch_start]
    batch_section = content[batch_start:]

    ATS_TYPES = ['greenhouse', 'lever', 'ashby', 'workday', 'icims', 'successfactors', 'taleo']

    if metric in ATS_TYPES:
        # Count occurrences in SEED_COMPANIES only
        count = seed_section.count(f"ats: '{metric}'")
        print(count)

    elif metric == 'seed_total':
        total = sum(seed_section.count(f"ats: '{a}'") for a in ATS_TYPES)
        print(total)

    elif metric == 'batch_total':
        # Count entries in BATCH_WATCHLIST by { name: pattern
        count = len(re.findall(r"{\s*name\s*:", batch_section))
        print(count)

    elif metric == 'batch_cpl':
        # Extract companies_per_cycle from config
        m = re.search(r'companies_per_cycle\s*:\s*(\d+)', content)
        print(m.group(1) if m else '?')

    else:
        print("?")
        sys.exit(1)

if __name__ == '__main__':
    main()
