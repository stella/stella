#!/usr/bin/env bash
set -euo pipefail

# An alternate command lets tests exercise the scheduler without network calls.
check_command="${1:-scripts/staging-deploy-check.sh}"
logs="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/staging-checks.XXXXXX")"
trap 'rm -rf "$logs"' EXIT
checks=(web-smoke response-policy api-smoke model-turn corpus-preflight mcp-smoke)
for check in "${checks[@]}"; do
  echo skipped > "$logs/$check.status"
  : > "$logs/$check.log"
  : > "$logs/$check.summary"
done

run_check() {
  local check="$1"
  if GITHUB_STEP_SUMMARY="$logs/$check.summary" bash "$check_command" "$check" > "$logs/$check.log" 2>&1; then
    echo success > "$logs/$check.status"
    return 0
  fi
  echo failure > "$logs/$check.status"
  return 1
}

pids=()
if [[ "${RUN_WEB_SMOKE:-true}" == true ]]; then
  (run_check web-smoke) &
  pids+=("$!")
fi
for check in response-policy api-smoke model-turn; do
  (run_check "$check") &
  pids+=("$!")
done
(
  # A waived failure still skips MCP: only a healthy backend can verify search.
  if run_check corpus-preflight; then
    run_check mcp-smoke
  fi
) &
pids+=("$!")

# Never short-circuit on failure: every started check must finish and report.
for pid in "${pids[@]}"; do
  wait "$pid" || true
done

failed=0
for check in "${checks[@]}"; do
  outcome="$(cat "$logs/$check.status")"
  echo "$check=$outcome" >> "$GITHUB_OUTPUT"
  echo "::group::$check ($outcome)"
  cat "$logs/$check.log"
  echo '::endgroup::'
  cat "$logs/$check.summary" >> "$GITHUB_STEP_SUMMARY"
  case "$check" in
    response-policy|model-turn)
      if [[ "$check" == response-policy ]]; then
        label='Staging response policy checks'
      else
        label='Staging model-turn smoke'
      fi
      if [[ "$outcome" == failure ]]; then
        echo "::warning title=$label failed (report-only)::See the check log for the failed checks."
        echo "$label FAILED (report-only, promotion not blocked). See the check log." >> "$GITHUB_STEP_SUMMARY"
      else
        echo "$label passed." >> "$GITHUB_STEP_SUMMARY"
      fi
      ;;
    corpus-preflight)
      if [[ "$outcome" == failure && "${CORPUS_SEARCH_WAIVED:-false}" != true ]]; then
        failed=1
      fi
      ;;
    *)
      if [[ "$outcome" == failure ]]; then
        failed=1
      fi
      ;;
  esac
done
exit "$failed"
