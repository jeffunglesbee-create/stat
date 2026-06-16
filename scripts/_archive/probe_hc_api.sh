#!/bin/bash
# Probe HiringCafe's internal API endpoints directly
set +e
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
OUT="${1:-/tmp/hc-api-probe.txt}"

api_probe() {
    local LABEL="$1" URL="$2" METHOD="${3:-GET}" DATA="$4"
    printf '\n=== %s ===\nURL: %s\n' "$LABEL" "$URL" >> "$OUT"
    local TF; TF=$(mktemp)
    local ARGS=(-s --max-time 15 -o "$TF" -w "%{http_code}")
    [ "$METHOD" = "POST" ] && ARGS+=(-X POST -H "Content-Type: application/json" -d "$DATA")
    local HC
    HC=$(curl "${ARGS[@]}" \
        -H "User-Agent: $UA" \
        -H "Accept: application/json,*/*" \
        -H "Referer: https://hiring.cafe/" \
        "$URL" 2>/dev/null)
    printf 'HTTP: %s  bytes: %d\n' "$HC" "$(wc -c < "$TF")" >> "$OUT"
    head -c 500 "$TF" >> "$OUT"
    printf '\n' >> "$OUT"
    rm -f "$TF"
}

printf 'HiringCafe API Probe\n' > "$OUT"

# Try common Next.js API route patterns
api_probe "GET /api/search?q=epic+analyst" "https://hiring.cafe/api/search?q=epic+analyst&environment=remote&page=1"
api_probe "GET /api/jobs?q=epic" "https://hiring.cafe/api/jobs?q=epic+analyst&environment=remote"
api_probe "GET /api/jobs/search" "https://hiring.cafe/api/jobs/search?q=epic+analyst"
api_probe "POST /api/search" "https://hiring.cafe/api/search" POST '{"query":"epic analyst","environment":"remote","page":1}'
api_probe "GET /api/v1/search" "https://hiring.cafe/api/v1/search?q=epic+analyst"
api_probe "GET /api/v2/search" "https://hiring.cafe/api/v2/search?q=epic+analyst"

# Also try the widgets endpoint (phenom-style)
api_probe "GET /api/widgets" "https://hiring.cafe/api/widgets?q=epic"

# Check robots.txt for disallowed API paths (reveals internal structure)
api_probe "robots.txt" "https://hiring.cafe/robots.txt"

# Check sitemap
api_probe "sitemap.xml" "https://hiring.cafe/sitemap.xml"

printf '\nDONE\n' >> "$OUT"
cat "$OUT"
