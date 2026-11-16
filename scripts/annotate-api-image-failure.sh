#!/usr/bin/env bash
# CI: lift the failing lines of the API image build and smoke logs into
# workflow annotations (reads PLATFORM and RUNNER_TEMP).
set -eo pipefail
# Lift the failing lines out of the logs above into annotations.
# Values are bounded and escaped so a log line cannot end the
# workflow command or start another one.
escape() {
  local value=${1:0:500}
  value=${value//'%'/%25}
  value=${value//$'\r'/%0D}
  value=${value//$'\n'/%0A}
  printf '%s' "$value"
}
annotate() {
  printf '::error title=%s::%s\n' "$(escape "$1 ($PLATFORM)" | sed 's/:/%3A/g; s/,/%2C/g')" "$(escape "$2")"
}
build_log="$RUNNER_TEMP/api-image-build.log"
smoke_log="$RUNNER_TEMP/api-image-smoke.log"
if [[ -f "$smoke_log" ]]; then
  failures=$(grep -m 5 -E '^FAIL' "$smoke_log" || true)
  if [[ -n "$failures" ]]; then
    while IFS= read -r line; do
      annotate "API image smoke" "$line"
    done <<< "$failures"
  else
    last_pass=$(grep -E '^PASS' "$smoke_log" | tail -n 1 || true)
    annotate "API image smoke" "Failed after: ${last_pass:-no check passed}"
  fi
elif [[ -f "$build_log" ]]; then
  # Docker prefixes nested workflow commands with BuildKit progress.
  # Promote the install owner's fixed diagnostic to a runner annotation.
  stall=$(grep -m 1 -oE 'kind=infra class=install-stall .*' "$build_log" || true)
  if [[ -n "$stall" ]]; then
    printf '::error title=infra-stall::%s\n' "$stall"
    exit 0
  fi
  # BuildKit prefixes each line with its step number; keep the
  # output of the step that failed. Bun prints an uncaught error's
  # headline under a caret line; without one, fall back to error
  # words, then to the step's last line.
  step=$(grep -m 1 -oE '^#[0-9]+ ERROR' "$build_log" | grep -oE '[0-9]+' || true)
  if [[ -n "$step" ]]; then
    output=$(grep -E "^#$step [0-9.]+ " "$build_log" | sed -E 's/^#[0-9]+ [0-9.]+ //' || true)
    lines=$(awk 'prev ~ /^[[:space:]]*\^[[:space:]]*$/ || /FAIL|[Ee]rror|Panic/ { print } { prev = $0 }' <<< "$output" | tail -n 5)
    if [[ -z "$lines" ]]; then
      lines=$(grep -vE '^[[:space:]]*$' <<< "$output" | tail -n 1 || true)
    fi
    lines+=${lines:+$'\n'}$(grep -m 1 -E "^#$step ERROR" "$build_log" | sed -E 's/^#[0-9]+ //')
  else
    lines=$(grep -E '^ERROR' "$build_log" | tail -n 1 || true)
  fi
  while IFS= read -r line; do
    [[ -z "$line" ]] || annotate "API image build" "$line"
  done <<< "${lines:-docker build failed}"
fi
