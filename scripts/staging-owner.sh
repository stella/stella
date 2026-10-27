#!/usr/bin/env bash
# Waits until a staging promotion can begin without replacing another proof.
# A failed read refuses: an unknown owner is never treated as a free one.
set -euo pipefail

: "${GH_RETRY_SCRIPT:?GH_RETRY_SCRIPT is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"

readonly workflow="deploy-staging.yml"
readonly applying_step="Deploy to staging"
mode="${STAGING_OWNER_MODE:?STAGING_OWNER_MODE is required}"
interval="${STAGING_OWNER_INTERVAL_SECONDS:-30}"

api() {
  bash "$GH_RETRY_SCRIPT" api "$@"
}

read_failed() {
  echo "::error::Reading staging ownership failed; refusing to promote." >&2
  exit 1
}

candidate_busy() {
  local runs
  runs="$(api "/repos/${GITHUB_REPOSITORY}/actions/workflows/${workflow}/runs?per_page=100" --jq \
    ".workflow_runs[] | select(.id != ${GITHUB_RUN_ID}) | select(.display_title | startswith(\"Staging release proof \")) | select(.status == \"queued\" or .status == \"in_progress\") | .id")" ||
    read_failed
  [[ -n "$runs" ]]
}

ordinary_promote_busy() {
  local runs run_id jobs
  runs="$(api "/repos/${GITHUB_REPOSITORY}/actions/workflows/${workflow}/runs?status=in_progress&per_page=100" --jq \
    ".workflow_runs[] | select(.id != ${GITHUB_RUN_ID}) | select(.display_title | startswith(\"Deploy main to staging \")) | .id")" ||
    read_failed
  while IFS= read -r run_id; do
    [[ -n "$run_id" ]] || continue
    jobs="$(api "/repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/jobs?per_page=100" --jq \
      ".jobs[] | select(.name == \"Promote staging images\") | select(any(.steps[]; .name == \"${applying_step}\" and .status == \"in_progress\")) | .id")" ||
      read_failed
    [[ -z "$jobs" ]] || return 0
  done <<<"$runs"
  return 1
}

# An ordinary deploy waits out a whole candidate proof (promote and smokes);
# a candidate waits only for an ordinary promote already applying.
case "$mode" in
  ordinary) busy=candidate_busy; owner="a release-candidate staging proof"; default_attempts=240 ;;
  candidate) busy=ordinary_promote_busy; owner="an ordinary staging promotion"; default_attempts=60 ;;
  *) echo "::error::STAGING_OWNER_MODE must be candidate or ordinary." >&2; exit 2 ;;
esac
attempts="${STAGING_OWNER_ATTEMPTS:-$default_attempts}"

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
