#!/usr/bin/env bash
set -euo pipefail

readonly WORKFLOW_FILE=staging-power.yml
readonly GH_RETRY_SCRIPT="$GITHUB_ACTION_PATH/../../../scripts/gh-retry.sh"
readonly MAX_ATTEMPTS=120
readonly RETRY_SECONDS=10

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
expected_title="Staging power ${POWER_ACTION} ${lease_id}"
dispatched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
bash "$GH_RETRY_SCRIPT" api --method POST \
  "/repos/${INFRA_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches" \
  -f ref=main \
  -f "inputs[action]=$POWER_ACTION" \
  -f "inputs[lease_id]=$lease_id" \
  -f "inputs[caller_repository]=$GITHUB_REPOSITORY" \
  -f "inputs[caller_run_id]=$GITHUB_RUN_ID" \
  -f "inputs[caller_run_attempt]=$LEASE_ATTEMPT" \
  -f 'inputs[fallback_minutes]=30'

run_id=""
for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1)); do
  if [[ -z "$run_id" ]]; then
    # Bound the history scanned while retaining pagination for recent runs.
    runs="$(bash "$GH_RETRY_SCRIPT" api --paginate --slurp \
      "/repos/${INFRA_REPO}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&created=%3E%3D${dispatched_at}&per_page=100")"
    matches="$(jq -c --arg title "$expected_title" --arg since "$dispatched_at" \
      '[.[].workflow_runs[] | select(.display_title == $title and .created_at >= $since)]' <<<"$runs")"
    count="$(jq length <<<"$matches")"
    if (( count > 1 )); then
      echo "::error::Staging power dispatch matched multiple runs." >&2
      exit 1
    fi
    run_id="$(jq -r '.[0].id // empty' <<<"$matches")"
  fi
  if [[ -n "$run_id" ]]; then
    state="$(bash "$GH_RETRY_SCRIPT" api "/repos/${INFRA_REPO}/actions/runs/${run_id}")"
    if [[ "$(jq -r .status <<<"$state")" == completed ]]; then
      if [[ "$(jq -r .conclusion <<<"$state")" != success ]]; then
        echo "::error::Staging power transition did not succeed." >&2
        exit 1
      fi
      # On success, the receiver has completed a fresh rollout for this lease.
      exit 0
    fi
  fi
  sleep "$RETRY_SECONDS"
done

echo "::error::Staging power transition timed out." >&2
exit 1
