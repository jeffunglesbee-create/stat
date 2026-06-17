#!/usr/bin/env python3
"""
S27b — wd5 polling via Playwright XHR intercept + DataImpulse proxy.

Workday's listing page (?q={keyword}) returns an EMPTY React shell — no
job hrefs, no data-automation-id. But the React app immediately fires a
CXS POST XHR to /wday/cxs/{tenant}/{slug}/jobs to populate the list.
Playwright executes that JavaScript, so we can intercept the CXS XHR
response and read the jobPostings JSON directly. No CSRF cookies to
juggle — the browser handles them transparently.

Pipeline per tenant:
  page.goto(?q={keyword}&startIndex={offset})
    React boots → CXS POST XHR fires → page.on('response') captures JSON
  Iterate startIndex 0, 20, 40, ... until <20 returned (last page)
  Iterate keywords: epic ehr ambulatory cadence cogito clarity willow radiant
  Dedup by req_id, transform to /ingest shape, POST to Worker.

Constraints (per S27b spec):
  - JHBMC must be in the first 3 companies (it's the ground-truth control)
  - If JHBMC returns 0 jobs across all keywords → log + exit, do not ingest
  - Rate limit: 3s between companies, 2s between keywords, 1s between pages
  - Maintenance redirect to community.workday.com/maintenance-page → skip tenant
"""
from playwright.sync_api import sync_playwright
import json, re, os, sys, time
from urllib.parse import urlparse
import urllib.request, urllib.error

WORKER       = "https://stat-job-watcher.jeffunglesbee.workers.dev"
MAINTENANCE  = "community.workday.com/maintenance-page"
PAGE_SIZE    = 20
JHBMC_TENANT = "jhhs"

di_user      = os.environ["DI_USER"]
di_pass      = os.environ["DI_PASS"]
ingest_token = os.environ["STAT_INGEST_TOKEN"]
LIMIT             = int(os.environ.get("LIMIT", "3"))
MAX_OFFSET_PAGES  = int(os.environ.get("MAX_OFFSET_PAGES", "10"))
KEYWORDS          = [k.strip() for k in os.environ.get(
    "KEYWORDS",
    "epic,ehr,ambulatory,cadence,cogito,clarity,willow,radiant",
).split(",") if k.strip()]

inventory_path = "outbox/wd5-companies.json"
if not os.path.exists(inventory_path):
    print(f"::error::{inventory_path} missing", file=sys.stderr)
    sys.exit(1)
companies = json.load(open(inventory_path))["companies"][:LIMIT]
print(f"Inventory slice: {len(companies)} companies (limit={LIMIT})")
print(f"Keywords ({len(KEYWORDS)}): {KEYWORDS}")
if not any(c["tenant"] == JHBMC_TENANT for c in companies):
    print(f"::warning::JHBMC ({JHBMC_TENANT}) not in test slice; ground-truth guard disabled.")


def poll_company_keyword(page, base_url, keyword, max_pages):
    """Run startIndex pagination for one (tenant, keyword). Returns list of
    raw jobPostings, or None if maintenance page detected."""
    all_postings = []
    seen_req_ids_kw = set()
    for page_num in range(max_pages):
        offset = page_num * PAGE_SIZE
        url = f"{base_url}?q={keyword}&startIndex={offset}"
        captured = []

        def handle_response(response, captured=captured):
            try:
                if "/wday/cxs/" in response.url and "/jobs" in response.url and response.request.method == "POST":
                    data = response.json()
                    posts = data.get("jobPostings")
                    if isinstance(posts, list):
                        captured.extend(posts)
            except Exception:
                pass

        page.on("response", handle_response)
        try:
            page.goto(url, wait_until="networkidle", timeout=30000)
        except Exception as e:
            print(f"    page off={offset}: navigation error {e!r}")
            page.remove_listener("response", handle_response)
            break

        # Maintenance detection — Workday redirects via window.location
        final_url = page.url
        if MAINTENANCE in final_url:
            print(f"    page off={offset}: MAINTENANCE redirect — abort tenant")
            page.remove_listener("response", handle_response)
            return None

        page.remove_listener("response", handle_response)

        if not captured:
            print(f"    page off={offset}: zero CXS postings captured — stop")
            break

        # Dedup within the keyword pass (Workday sometimes returns overlap)
        new_here = 0
        for p in captured:
            ep = p.get("externalPath") or ""
            m = re.search(r"_([A-Za-z0-9-]+)$", ep)
            req_id = m.group(1) if m else (p.get("bulletFields") or [None])[0] or ep or p.get("title", "")
            req_id = str(req_id)
            if not req_id or req_id in seen_req_ids_kw:
                continue
            seen_req_ids_kw.add(req_id)
            all_postings.append(p)
            new_here += 1
        print(f"    page off={offset}: captured={len(captured)} new={new_here}")

        if len(captured) < PAGE_SIZE:
            break  # last page
        time.sleep(1)  # polite per-page (S27b spec)
    return all_postings


def transform_posting(posting, company):
    ep = posting.get("externalPath") or ""
    m = re.search(r"_([A-Za-z0-9-]+)$", ep)
    req_id = m.group(1) if m else (posting.get("bulletFields") or [None])[0] or ep or posting.get("title", "")
    host = urlparse(company["url"]).netloc
    loc = posting.get("locationsText") or ""
    env_tag = "remote" if "remote" in loc.lower() else ("hybrid" if "hybrid" in loc.lower() else "")
    return {
        "id":          f"{company['tenant']}_{req_id}" if not str(req_id).startswith("R") else str(req_id),
        "title":       posting.get("title") or "",
        "company":     company["name"],
        "location":    loc,
        "environment": env_tag,
        "url":         f"https://{host}/en-US{ep}" if ep else company["url"],
        "postedAt":    posting.get("postedOn"),
        "atsSource":   "workday",
        "description": "",
    }


def post_ingest(jobs, source):
    if not jobs:
        return None
    payload = json.dumps({"source": source, "jobs": jobs}).encode()
    req = urllib.request.Request(
        WORKER + "/ingest", data=payload, method="POST",
        headers={"Content-Type": "application/json", "X-STAT-Ingest": ingest_token},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read(800).decode()
            return {"http": r.status, "body": body}
    except urllib.error.HTTPError as e:
        return {"http": e.code, "body": e.read(500).decode()}
    except Exception as e:
        return {"http": "ERR", "body": str(e)}


per_company_results = []
jhbmc_unique_count = None
ingest_blocked = False
ingest_summary = []

with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=True,
        proxy={"server": "http://gw.dataimpulse.com:823", "username": di_user, "password": di_pass},
    )
    for company in companies:
        name    = company["name"]
        tenant  = company["tenant"]
        cluster = company["cluster"]
        base    = company["url"].split("?")[0]
        print(f"\n=== {name} ({tenant}.{cluster}) ===")
        ctx = browser.new_context()
        page = ctx.new_page()

        unique_by_req = {}
        maintenance = False
        for kw in KEYWORDS:
            print(f"  --- keyword: {kw} ---")
            postings = poll_company_keyword(page, base, kw, MAX_OFFSET_PAGES)
            if postings is None:
                maintenance = True
                break
            for post in postings:
                job = transform_posting(post, company)
                if job["id"] and job["id"] not in unique_by_req:
                    unique_by_req[job["id"]] = job
            time.sleep(2)  # polite per-keyword (S27b spec)

        ctx.close()

        unique_jobs = list(unique_by_req.values())
        per_company_results.append({
            "tenant": tenant, "cluster": cluster, "name": name,
            "maintenance": maintenance,
            "unique_jobs": len(unique_jobs),
        })
        if maintenance:
            print(f"  → {name}: MAINTENANCE, skipped")
        else:
            print(f"  → {name}: {len(unique_jobs)} unique jobs across {len(KEYWORDS)} keywords")

        # JHBMC ground-truth guard — if JHBMC is in the slice and returns
        # zero jobs across all keywords (and isn't in maintenance), do NOT
        # ingest anything from this run. Per S27b spec.
        if tenant == JHBMC_TENANT and not maintenance:
            jhbmc_unique_count = len(unique_jobs)
            if jhbmc_unique_count == 0:
                print(f"::error::JHBMC ({JHBMC_TENANT}) returned 0 jobs — blocking ingest, stopping sweep.")
                ingest_blocked = True
                break

        # Ingest per tenant (so failures don't lose prior tenants' data)
        if not ingest_blocked and unique_jobs:
            ir = post_ingest(unique_jobs, f"wd5-playwright:{tenant}.{cluster}")
            if ir:
                print(f"  ingest: http={ir['http']} body={ir['body'][:200]}")
                ingest_summary.append({"tenant": tenant, "ingest_http": ir["http"], "body_excerpt": ir["body"][:200]})

        time.sleep(3)  # polite per-tenant (S27b spec)

    browser.close()

# Write run summary
ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
out_path = f"outbox/wd5-playwright-poll-{ts}.json"
json.dump({
    "ts": ts,
    "limit": LIMIT,
    "keywords": KEYWORDS,
    "max_offset_pages": MAX_OFFSET_PAGES,
    "jhbmc_unique_count": jhbmc_unique_count,
    "ingest_blocked": ingest_blocked,
    "per_company": per_company_results,
    "ingest": ingest_summary,
}, open(out_path, "w"), indent=2)
print(f"\nWrote {out_path}")

print("\n=== SUMMARY ===")
for r in per_company_results:
    marker = "🛠" if r["maintenance"] else ("✅" if r["unique_jobs"] > 0 else "⚠️")
    print(f"  {marker} {r['name']}: jobs={r['unique_jobs']} maintenance={r['maintenance']}")
if ingest_blocked:
    print("\nINGEST WAS BLOCKED — JHBMC ground-truth guard tripped.")
    sys.exit(0)  # workflow itself succeeded; we explicitly chose not to ingest
