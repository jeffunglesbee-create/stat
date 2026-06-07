import urllib.request, json, datetime

BASE = 'https://stat-job-watcher.jeffunglesbee.workers.dev'
HEADERS = {'User-Agent': 'STAT-probe/1.0', 'Accept': 'application/json'}

print(f"Probe time: {datetime.datetime.utcnow().isoformat()}Z")

for path in ['/', '/companies', '/jobs?limit=1']:
    url = BASE + path
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=15) as r:
            body = r.read().decode('utf-8', errors='replace')
            print(f"\n=== {path} ===")
            print(f"HTTP: {r.status}")
            try:
                data = json.loads(body)
                print(json.dumps(data, indent=2)[:1000])
            except:
                print(body[:400])
    except Exception as e:
        print(f"\n=== {path} ===")
        print(f"ERROR: {type(e).__name__}: {e}")
