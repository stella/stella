#!/usr/bin/env bash
# Read-only journeys; external output is private except redacted failure excerpts.
set -euo pipefail
umask 077
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
failed=0
detail=
reason=contract_error
credential="${MCP_CANARY_TOKEN:-}"
unset MCP_CANARY_TOKEN
protocol_version=2025-11-25
session_id=
request_count=0
# At most three extra HTTP requests: the hourly run stays within ten.
retry_budget=3
pause="${JOURNEY_RETRY_PAUSE_SECONDS:-5}"
deadline="${JOURNEY_TIMEOUT_SECONDS:-15}"
web="${JOURNEY_WEB_URL:-https://my.stll.app}"
mcp="${JOURNEY_MCP_URL:-https://api.stll.app/mcp}"
cli_server="${JOURNEY_CLI_URL:-https://api.stll.app}"
decision_id="01a10c6e-cd77-77cc-97bd-19a8dc2e360c"
decision_path="/law/cze/cases/nejvyssi-spravni-soud/2-azs-146-2026"

report() {
  printf 'journey %s %s %s\n' "$1" "$2" "$3"
  if [[ "$2" != failed ]]; then return; fi
  failed=1
  case "$1" in
    cli_*|mcp_*)
      local excerpt="$detail"
      if [[ -z "$excerpt" && -s "$scratch/error" ]]; then
        excerpt="$(head -n 1 "$scratch/error")"
      fi
      excerpt="${excerpt:-check failed: $3}"
      excerpt="$(printf '%s' "$excerpt" | JOURNEY_DETAIL_CREDENTIAL="$credential" JOURNEY_DETAIL_SESSION="$session_id" \
        jq -Rrs -f "$script_dir/journey-detail.jq")"
      printf 'journey-detail %s %s\n' "$1" "$excerpt"
      ;;
  esac
}

request() {
  detail=
  local response status redirects allowed_redirects="${redirect_limit:-0}" rc=0
  if [[ "$request_count" -ge 10 ]]; then reason=http_status; return 1; fi
  request_count=$((request_count + 1))
  if [[ "$allowed_redirects" -gt $((10 - request_count)) ]]; then allowed_redirects=$((10 - request_count)); fi
  response="$(curl --silent --location --max-redirs "$allowed_redirects" --max-time "$deadline" --max-filesize 4000000 \
    --dump-header "$scratch/headers" --output "$scratch/body" --write-out '%{http_code} %{num_redirects}' "$@" 2>"$scratch/error")" || rc=$?
  status="${response%% *}"
  redirects="${response##* }"
  request_count=$((request_count + redirects))
  if [[ ! -s "$scratch/error" ]]; then detail="HTTP status check: received $status (curl exit $rc)"; fi
  if [[ "$rc" == 28 ]]; then reason=timeout; return 1; fi
  if [[ "$status" == 401 || "$status" == 403 ]]; then reason=auth_rejected; return 1; fi
  if [[ "$rc" != 0 || ! "$status" =~ ${accepted_status:-^200$} ]]; then reason=http_status; return 1; fi
}

probe() {
  detail=
  probe_status=passed
  probe_reason=ok
  : > "$scratch/error"
  local name="$1"
  shift
  if "$@"; then report "$name" "$probe_status" "$probe_reason"; return; fi
  local first_reason="$reason"
  if [[ "$reason" != auth_rejected && "$retry_budget" -gt 0 ]]; then
    retry_budget=$((retry_budget - 1))
    sleep "$pause"
    detail=
    : > "$scratch/error"
    if "$@"; then
      if [[ "$probe_status" == skipped ]]; then
        report "$name" skipped "$probe_reason"
      else
        report "$name" passed_after_retry "$first_reason"
      fi
      return
    fi
  fi
  report "$name" failed "$reason"
}

web_check() {
  local redirect_limit=1
  request "$1" || return 1
  reason=missing_marker
  # Only rendered tags count, not the dehydrated router payload.
  jq -rRs 'gsub("<script\\b[^>]*>[\\s\\S]*?</script>"; "")' "$scratch/body" > "$scratch/html" 2>"$scratch/error" || return 1
  grep -Eq '<h1[ >]' "$scratch/html" && grep -Eq "$2" "$scratch/html" || return 1
  reason=http_status
}

rpc() {
  request -H "Authorization: Bearer ${credential}" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H "MCP-Protocol-Version: $protocol_version" -H "Mcp-Session-Id: $session_id" --data "$1" "$mcp" || return 1
  reason=contract_error
  detail="JSON-RPC envelope: expected matching id and object result"
  # Streamable HTTP may answer a JSON envelope or an SSE data frame.
  if [[ "$(head -c 1 "$scratch/body")" != '{' ]]; then
    sed -n 's/^data: //p' "$scratch/body" > "$scratch/frame"
    mv "$scratch/frame" "$scratch/body"
  fi
  if jq -e '.error != null' "$scratch/body" >/dev/null 2>"$scratch/error"; then
    auth_rejection "$scratch/body"
    return 1
  fi
  jq -e --argjson id "$2" '.jsonrpc == "2.0" and .id == $id and (.error == null) and (.result | type == "object")' \
    "$scratch/body" > /dev/null 2>"$scratch/error" || return 1
}

initialize() {
  session_id=
  protocol_version=2025-11-25
  rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"journey-canary","version":"1"}}}' 1 || return 1
  detail="initialize shape check: protocolVersion date and nonempty serverInfo.name"
  jq -e '.result | (.protocolVersion | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")) and (.serverInfo.name | type == "string" and length > 0)' \
    "$scratch/body" >/dev/null 2>"$scratch/error" || return 1
  protocol_version="$(jq -r '.result.protocolVersion' "$scratch/body")"
  session_id="$(awk 'tolower($1) == "mcp-session-id:" { sub(/\r$/, "", $2); print $2 }' "$scratch/headers")"
  if [[ -n "$session_id" ]]; then
    local accepted_status='^(202|204)$'
    request -H "Authorization: Bearer $credential" -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' -H "MCP-Protocol-Version: $protocol_version" \
      -H "Mcp-Session-Id: $session_id" --data '{"jsonrpc":"2.0","method":"notifications/initialized"}' "$mcp" || return 1
  fi
  reason=contract_error
  detail=
}

validate_payload() {
  reason=contract_error
  detail="payload shape check: $1"
  jq -e "$1" "$scratch/payload" >/dev/null 2>"$scratch/error" || return 1
  reason=empty_result
  detail="payload nonempty check: $2"
  jq -e "$2" "$scratch/payload" >/dev/null 2>"$scratch/error" || return 1
  reason=contract_error
}

case_shape='.results | type == "array" and all(.[]; type == "object" and (.decisionId | type == "string" and length > 0) and (.caseNumber | type == "string" and length > 0))'
case_nonempty='.results | length > 0'
read_shape='.items | type == "array" and all(.[]; .status == "found" and (.decision | type == "object") and (.decision.text | type == "string" or . == null))'
read_nonempty='.items | length > 0 and all(.[]; .decision.text | type == "string" and test("\\S"))'
statute_shape='.results | type == "array" and all(.[]; type == "object" and (.documentId | type == "string" and length > 0) and (.eli | type == "string" and length > 0) and (.title | type == "string" and length > 0))'
statute_nonempty='.results | length > 0'

mcp_tool() {
  local payload
  payload="$(jq -nc --arg name "$1" --argjson args "$2" '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:$name,arguments:$args}}')"
  rpc "$payload" 2 || return 1
  detail="tool result check: isError must not be true"
  if ! jq -e '.result.isError != true' "$scratch/body" >/dev/null 2>"$scratch/error"; then
    auth_rejection "$scratch/body"
    return 1
  fi
  detail="tool content check: expected exactly one JSON text payload"
  jq -e '.result.content | map(select(.type == "text") | .text | fromjson) | if length == 1 then .[0] else error("contract") end' \
    "$scratch/body" > "$scratch/payload" 2>"$scratch/error" || return 1
  validate_payload "$3" "$4"
}

cli_version() {
  reason=contract_error
  if ! env -u MCP_CANARY_TOKEN -u STELLA_API_KEY -u GITHUB_TOKEN -u GH_TOKEN npm i -g @stll/cli --ignore-scripts --prefix "$scratch/install" >"$scratch/install-log" 2>"$scratch/error"; then return 1; fi
  cli="$scratch/install/bin/stella"
  actual="$(env -u MCP_CANARY_TOKEN -u STELLA_API_KEY -u GITHUB_TOKEN -u GH_TOKEN "$cli" --version 2>"$scratch/error")" || return 1
  bun "$script_dir/check-cli-promotion.ts" "$actual" >"$scratch/promotion" 2>"$scratch/error" || return 1
  probe_status="$(jq -er '.status | select(. == "passed" or . == "skipped" or . == "failed")' "$scratch/promotion" 2>"$scratch/error")" || return 1
  probe_reason="$(jq -er '.reason' "$scratch/promotion" 2>"$scratch/error")" || return 1
  detail="$(jq -r 'if .target then "target \(.target); publication deadline \(.deadline)" else .message // "promotion metadata check failed" end' "$scratch/promotion")"
  reason="$probe_reason"
  if [[ "$probe_status" == skipped ]]; then
    printf 'journey-detail cli_version %s\n' "$detail"
  fi
  [[ "$probe_status" != failed ]]
}

cli_tool() {
  reason=contract_error
  detail=
  local shape="$1" nonempty="$2" rc=0
  shift 2
  env -u GITHUB_TOKEN -u GH_TOKEN STELLA_API_KEY="${credential}" STELLA_SERVER_URL="$cli_server" \
    XDG_CONFIG_HOME="$scratch/config" XDG_CACHE_HOME="$scratch/cache" \
    "$cli" "$@" --json >"$scratch/payload" 2>"$scratch/error" || rc=$?
  # A rejected server registry leaves the CLI on its built-in commands: never a pass,
  # and the root cause of any built-in failure that follows.
  if grep -q 'registry refresh rejected' "$scratch/error"; then
    reason=registry_rejected
    return 1
  fi
  if [[ "$rc" != 0 ]]; then
    if [[ ! -s "$scratch/error" ]]; then detail="CLI exited $rc"; fi
    auth_rejection "$scratch/error" "$scratch/payload"
    return 1
  fi
  validate_payload "$shape" "$nonempty"
}

auth_rejection() {
  if grep -Eiq '(^|[^0-9])(401|403)([^0-9]|$)|key.{0,40}rejected|rejected.{0,40}key' "$@"; then
    reason=auth_rejected
  fi
}

case_args='{"queries":["smlouva"],"country":"CZE","limit":1}'
read_args="$(jq -nc --arg id "$decision_id" '{decision_ids:[$id],max_chars:1000,include:[]}')"
if [[ "${1:-}" == --cli ]]; then
  probe cli_version cli_version
  if [[ "$probe_status" == skipped ]]; then
    report cli_search skipped "$probe_reason"
    report cli_read skipped "$probe_reason"
    printf 'journey-detail cli_search %s\njourney-detail cli_read %s\n' "$detail" "$detail"
  elif [[ "$failed" != 0 ]]; then
    report cli_search failed "$reason"
    report cli_read failed "$reason"
  elif [[ -z "$credential" ]]; then
    report cli_search skipped no_credential
    report cli_read skipped no_credential
  else
    probe cli_search cli_tool "$case_shape" "$case_nonempty" case-law search --queries smlouva --country CZE --limit 1
    probe cli_read cli_tool "$read_shape" "$read_nonempty" case-law read --decision-ids "$decision_id"
  fi
else
  probe web_search web_check "${JOURNEY_WEB_SEARCH_URL:-$web/law/cases?q=smlouva&country=cze}" '<a[[:space:]][^>]*href="/law/cze/cases/[^" ]+"'
  probe web_decision web_check "${JOURNEY_WEB_DECISION_URL:-$web$decision_path}" '<article[ >]'
  probe web_statutes web_check "${JOURNEY_WEB_STATUTES_URL:-$web/law/cze/statutes/}" '<a[[:space:]][^>]*href="/law/cze/statutes/[^" ]+"'
  if [[ -z "$credential" ]]; then
    for name in mcp_initialize mcp_search mcp_read mcp_legislation; do report "$name" skipped no_credential; done
  else
    probe mcp_initialize initialize
    probe mcp_search mcp_tool search_case_law "$case_args" "$case_shape" "$case_nonempty"
    probe mcp_read mcp_tool read_case_law_decision "$read_args" "$read_shape" "$read_nonempty"
    probe mcp_legislation mcp_tool search_legislation '{"query":"smlouva","country":"CZE","limit":1}' "$statute_shape" "$statute_nonempty"
  fi
fi
exit "$failed"
