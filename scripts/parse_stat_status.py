#!/usr/bin/env python3
"""Parse STAT Worker GET / JSON from stdin and print key fields."""
import sys, json
try:
    d = json.load(sys.stdin)
    print('seenJobIds:', d.get('seenJobIds'))
    print('activeDOs:', d.get('activeDOs'))
except Exception:
    print('ERROR')
