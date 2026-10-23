#!/usr/bin/env bash
set -euo pipefail
curl_edge_args=()
if [[ -n "${E2E_EDGE_HEADER_NAME:-}" && -n "${E2E_EDGE_HEADER_VALUE:-}" ]]; then
  curl_edge_args+=(--header "${E2E_EDGE_HEADER_NAME}: ${E2E_EDGE_HEADER_VALUE}")
fi
response_file="$RUNNER_TEMP/staging-corpus-search.json"
http_status="000"
if ! http_status="$(curl --connect-timeout 5 --max-time 30 \
  --silent --show-error --output "$response_file" --write-out '%{http_code}' \
  --header 'Content-Type: application/json' \
  ${curl_edge_args[@]+"${curl_edge_args[@]}"} \
  --data '{"query":"contract","country":"CZ","limit":1,"strict":true}' \
  "${E2E_API_URL}/v1/case/decisions/search")"; then
  http_status="000"
fi
if [[ "$http_status" != "200" ]] || ! jq -e \
  'type == "object" and (.hits | type == "array") and (.queryUsed | type == "string" and length > 0) and has("total") and (has("message") | not)' \
  "$response_file" >/dev/null 2>&1; then
  echo "::error title=corpus index down::Staging case-law search preflight failed (HTTP ${http_status}); MCP smoke cannot verify search without its backend."
  echo "corpus index down: staging case-law search preflight failed (HTTP ${http_status})." >> "$GITHUB_STEP_SUMMARY"
  exit 1
fi
echo "Staging corpus search backend answered the preflight." >> "$GITHUB_STEP_SUMMARY"
