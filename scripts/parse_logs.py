#!/usr/bin/env python3
"""Parse STAT Worker /logs JSON response into readable text."""
import sys, json

try:
    entries = json.load(sys.stdin)
except Exception as e:
    print(f"parse error: {e}")
    sys.exit(0)

if not entries:
    print("(no entries)")
    sys.exit(0)

for e in entries:
    ts   = e.get('ts', '?')[:19].replace('T', ' ')
    etype = e.get('type', '?')

    if etype == 'alarm':
        ats      = e.get('ats', '?')
        polled   = e.get('polled', 0)
        matches  = e.get('newMatches', 0)
        errors   = e.get('errors', [])
        cursor   = e.get('cursor', '?')
        err_str  = f" ERRORS={len(errors)}" if errors else ""
        match_str = f" MATCHES={matches}" if matches else ""
        print(f"{ts}  {ats:20s}  polled={polled:3d}  cursor={cursor:4s}{match_str}{err_str}")
        for err in errors[:3]:
            print(f"              ↳ {err.get('company','?')}: {err.get('error','?')[:80]}")

    elif etype == 'hc_poll':
        matches = e.get('newMatches', 0)
        match_str = f"  MATCHES={matches}" if matches else ""
        print(f"{ts}  {'hiringcafe':20s}{match_str}")

    else:
        print(f"{ts}  {etype}: {json.dumps(e)[:120]}")
