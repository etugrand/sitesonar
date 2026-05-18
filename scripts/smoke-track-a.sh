#!/usr/bin/env bash
# Smoke-test all Track A endpoints against a running Sitesonar.
# Usage: BASE=https://api.example.com KEY=ss_live_... bash scripts/smoke-track-a.sh

set -euo pipefail
BASE="${BASE:-http://localhost:8080}"
KEY="${KEY:?Set KEY=ss_live_...}"

hit() {
  local path="$1"
  local body="$2"
  echo "==> POST ${BASE}${path}"
  echo "    body: ${body}"
  curl -sS -X POST "${BASE}${path}" \
    -H "Authorization: Bearer ${KEY}" \
    -H "Content-Type: application/json" \
    -d "${body}" \
    | jq -C 'if .error then . else (with_entries(select(.key != "html" and .key != "raw" and .key != "contentHtml"))) end' \
    | head -60
  echo ""
}

echo "Smoke testing Track A endpoints against ${BASE}"

hit /v1/security '{"url":"https://github.com"}'
hit /v1/robots   '{"url":"https://www.google.com","userAgent":"Googlebot"}'
hit /v1/sitemap  '{"url":"https://www.google.com/sitemap.xml","limit":10}'
hit /v1/extract  '{"url":"https://en.wikipedia.org/wiki/Sitemaps"}'
hit /v1/tech     '{"url":"https://wordpress.org"}'

echo "All Track A endpoints responded."
