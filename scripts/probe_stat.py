import urllib.request, json, sys, os

url = 'https://stat-job-watcher.jeffunglesbee.workers.dev/'
try:
    req = urllib.request.Request(url, headers={'User-Agent': 'STAT-probe/1.0', 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=15) as r:
        body = r.read().decode('utf-8', errors='replace')
        print(f'HTTP: {r.status}')
        print(f'Content-Type: {r.headers.get("Content-Type","?")}')
        try:
            data = json.loads(body)
            print('BODY:')
            print(json.dumps(data, indent=2)[:3000])
        except:
            print('BODY (raw):')
            print(body[:2000])
except Exception as e:
    print(f'ERROR: {type(e).__name__}: {e}')
