#!/usr/bin/env bash
# Waits until a staging promotion can begin without replacing another proof.
set -euo pipefail

: "${GH_RETRY_SCRIPT:?GH_RETRY_SCRIPT is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"

mode="${STAGING_OWNER_MODE:?STAGING_OWNER_MODE is required}"
attempts="${STAGING_OWNER_ATTEMPTS:-18}"
interval="${STAGING_OWNER_INTERVAL_SECONDS:-30}"
workflow="${STAGING_OWNER_WORKFLOW:-deploy-staging.yml}"

api() {
  bash "$GH_RETRY_SCRIPT" api "$@"
}

candidate_busy() {
  api "/repos/${GITHUB_REPOSITORY}/actions/workflows/${workflow}/runs?per_page=100" --jq \
    ".workflow_runs[] | select(.id != ${GITHUB_RUN_ID}) | select(.display_title | startswith(\"Staging release proof \")) | select(.status == \"queued\" or .status == \"in_progress\") | .id" |
    grep -q .
}

ordinary_promote_busy() {
  local run_id
  while IFS= read -r run_id; do
    [[ -n "$run_id" ]] || continue
    if api "/repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/jobs?per_page=100" --jq \
      '.jobs[] | select(.name == "Promote staging images" and .status == "in_progress") | .id' | grep -q .; then
      return 0
    fi
  done < <(api "/repos/${GITHUB_REPOSITORY}/actions/workflows/${workflow}/runs?status=in_progress&per_page=100" --jq \
    ".workflow_runs[] | select(.id != ${GITHUB_RUN_ID}) | select(.display_title | startswith(\"Deploy main to staging \")) | .id")
  return 1
}

case "$mode" in
  ordinary) busy=candidate_busy; owner="a release-candidate staging proof" ;;
  candidate) busy=ordinary_promote_busy; owner="an ordinary staging promotion" ;;
  *) echo "::error::STAGING_OWNER_MODE must be candidate or ordinary." >&2; exit 2 ;;
esac

for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  if ! "$busy"; then
    echo "Staging promotion ownership is available."
    exit 0
  fi
  if ((attempt == attempts)); then
    echo "::error::Timed out waiting for ${owner} to finish." >&2
    exit 1
  fi
  echo "Waiting for ${owner} to finish (${attempt}/${attempts})."
  sleep "$interval"
done
