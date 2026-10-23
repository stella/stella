#!/usr/bin/env bash
set -euo pipefail

readonly WORKFLOW_FILE=staging-power.yml
readonly GH_RETRY_SCRIPT="$GITHUB_ACTION_PATH/../../../scripts/gh-retry.sh"
readonly MAX_ATTEMPTS=120
readonly RETRY_SECONDS=10
readonly READINESS_TIMEOUT_SECONDS=2700
readonly STATUS_POLL_SECONDS=60

if [[ ! "$INFRA_REPO" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]]; then
  echo "::error::A staging power repository is required." >&2
  exit 1
fi
case "$POWER_ACTION" in
  on|off) ;;
  *) echo "::error::Unknown staging power action." >&2; exit 1 ;;
esac
if [[ ! "${LEASE_ATTEMPT:-}" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::The run attempt that acquired the staging lease is required." >&2
  exit 1
fi

# The acquisition deadline includes start dispatch and every status request.
if [[ "$POWER_ACTION" == on ]]; then
  deadline=$(( $(date +%s) + READINESS_TIMEOUT_SECONDS ))
else
  deadline=$(( $(date +%s) + MAX_ATTEMPTS * RETRY_SECONDS ))
fi

require_power_budget() {
  if (( $(date +%s) >= deadline )); then
    echo "::error::Staging power readiness timed out." >&2
    return 1
  fi
}

power_api() {
  require_power_budget || return "$?"
  bash "$GH_RETRY_SCRIPT" api "$@"
}
# shellcheck source=scripts/github-app-token.sh
source "$GITHUB_ACTION_PATH/../../../scripts/github-app-token.sh"

GH_TOKEN="$(mint_app_token)"
[[ -n "$GH_TOKEN" ]] || { echo "::error::GitHub App token creation failed." >&2; exit 1; }
echo "::add-mask::$GH_TOKEN"
export GH_TOKEN
trap '
  TRANSITION_EXIT_STATUS=$?
  if ! bash "$GH_RETRY_SCRIPT" api --method DELETE /installation/token >/dev/null; then
    echo "::warning::GitHub App token revocation failed." >&2
  fi
  exit "$TRANSITION_EXIT_STATUS"
' EXIT

# The caller identity is stable across acquisition and cleanup, but distinct
# for reruns. The receiver must release only this lease, even on duplicate off.
# Cleanup passes the attempt that acquired the lease: rerunning only a failed
# cleanup job runs in a later attempt and must still release that lease.
lease_id="${GITHUB_REPOSITORY}:${GITHUB_RUN_ID}:${LEASE_ATTEMPT}"
dispatch_and_wait() {
  local requested_action="$1"
  local expected_title dispatched_at runs matches count state attempt
  expected_title="Staging power ${requested_action} ${lease_id}"
  dispatched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  power_api --method POST \
    "/repos/${INFRA_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches" \
    -f ref=main \
    -f "inputs[action]=$requested_action" \
    -f "inputs[lease_id]=$lease_id" \
    -f "inputs[caller_repository]=$GITHUB_REPOSITORY" \
    -f "inputs[caller_run_id]=$GITHUB_RUN_ID" \
    -f "inputs[caller_run_attempt]=$LEASE_ATTEMPT" \
    -f 'inputs[fallback_minutes]=30'

  watched_run_id=""
  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1)); do
    if [[ -z "$watched_run_id" ]]; then
      # Bound history without assuming the matching run is on the first page.
      runs="$(power_api --paginate --slurp \
        "/repos/${INFRA_REPO}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&created=%3E%3D${dispatched_at}&per_page=100")"
      matches="$(jq -c --arg title "$expected_title" --arg since "$dispatched_at" \
        '[.[].workflow_runs[] | select(.display_title == $title and .created_at >= $since)]' <<<"$runs")"
      count="$(jq length <<<"$matches")"
      if (( count > 1 )); then
        echo "::error::Staging power dispatch matched multiple runs." >&2
        exit 1
      fi
      watched_run_id="$(jq -r '.[0].id // empty' <<<"$matches")"
    fi
    if [[ -n "$watched_run_id" ]]; then
      state="$(power_api "/repos/${INFRA_REPO}/actions/runs/${watched_run_id}")"
      if [[ "$(jq -r .status <<<"$state")" == completed ]]; then
        if [[ "$(jq -r .conclusion <<<"$state")" != success ]]; then
          echo "::error::Staging power transition did not succeed." >&2
          exit 1
        fi
        return 0
      fi
    fi
    sleep "$RETRY_SECONDS"
  done
  echo "::error::Staging power transition timed out." >&2
  exit 1
}

dispatch_and_wait "$POWER_ACTION"
[[ "$POWER_ACTION" == on ]] || exit 0

while true; do
  dispatch_and_wait status
  jobs="$(power_api --paginate --slurp \
    "/repos/${INFRA_REPO}/actions/runs/${watched_run_id}/jobs?filter=latest&per_page=100")"
  report="$(jq -er '
    [.[].jobs[] | select(.name == "Pipeline staging power status")] |
    if length == 1 and .[0].status == "completed" and .[0].conclusion == "success"
    then .[0].steps else error("Invalid staging power status job") end |
    ["Report fresh", "Report pending", "Report failed"] as $names |
    [.[] | select(.name as $name | $names | index($name))] as $reports |
    if ($reports | length) == 3 and
       ($reports | map(.name) | sort) == ($names | sort) and
       all($reports[]; .conclusion == "success" or .conclusion == "skipped")
    then [$reports[] | select(.conclusion == "success")] |
      if length == 1 then .[0].name else error("Invalid staging power status reports") end
    else error("Invalid staging power status reports") end
  ' <<<"$jobs")"
  require_power_budget
  case "$report" in
    "Report fresh") exit 0 ;;
    "Report pending") sleep "$STATUS_POLL_SECONDS" ;;
    "Report failed") echo "::error::Staging power readiness failed." >&2; exit 1 ;;
    *) echo "::error::Unknown staging power readiness state." >&2; exit 1 ;;
  esac
done
