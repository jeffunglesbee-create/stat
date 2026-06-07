import urllib.request, json, sys

url = 'https://stat-job-watcher.jeffunglesbee.workers.dev/'
try:
    req = urllib.request.Request(url, headers={'User-Agent': 'STAT-probe/1.0'})
    with urllib.request.urlopen(req, timeout=15) as r:
        body = r.read().decode('utf-8', errors='replace')
        print(f'HTTP: {r.status}')
        print(f'Content-Type: {r.headers.get("Content-Type", "?")}')
        # If JSON, pretty print first 2000 chars
        try:
            data = json.loads(body)
            print('BODY (JSON):')
            print(json.dumps(data, indent=2)[:2000])
        except:
            print(f'BODY (first 1000 chars):')
            print(body[:1000])
except Exception as e:
    print(f'ERROR: {e}')
