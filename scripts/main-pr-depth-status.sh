#!/usr/bin/env bash
set -euo pipefail

# Publishes the main/pr-depth commit status for one Main PR-depth run.
# A run whose suites were cancelled writes nothing when a later scheduled run for
# the same commit is running or completed green. A queued successor can be
# replaced before it starts, so it cannot own publication. Every other outcome
# is published as success or failure.

: "${RESULTS:?}" "${RUN_ID:?}" "${REPOSITORY:?}" "${RUN_URL:?}"
SHA=${SHA:-}
gh_retry=${GH_RETRY:-"$(dirname "$0")/gh-retry.sh"}

state=failure
if jq -e 'all(.[]; .result == "success")' <<< "$RESULTS" > /dev/null; then
  state=success
elif [[ -n "$SHA" ]] && jq -e \
  'any(.[]; .result == "cancelled") and all(.[]; .result == "success" or .result == "cancelled" or .result == "skipped")' \
  <<< "$RESULTS" > /dev/null; then
  runs=$(bash "$gh_retry" api "repos/$REPOSITORY/actions/workflows/main-pr-depth.yml/runs?per_page=50")
  if jq -e --arg title "Main PR-depth checks $SHA" --argjson run "$RUN_ID" \
    'any(.workflow_runs[]; .id > $run and .display_title == $title and .event == "schedule"
      and (.status == "in_progress" or (.status == "completed" and .conclusion == "success")))' \
    <<< "$runs" > /dev/null; then
    echo "A later run for $SHA is running or completed green and owns main/pr-depth."
    exit 0
  fi
fi

if [[ -n "$SHA" ]]; then
  bash "$gh_retry" api --method POST "repos/$REPOSITORY/statuses/$SHA" \
    -f context=main/pr-depth -f state="$state" \
    -f description="Main PR-depth checks: $state" -f target_url="$RUN_URL"
fi
[[ "$state" == success ]]
