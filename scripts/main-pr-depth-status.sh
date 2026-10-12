#!/usr/bin/env bash
set -euo pipefail

# Publishes the main/pr-depth commit status for one Main PR-depth run.
# A run whose suites were cancelled defers to a later run for the same commit:
# pending while that run is live, nothing once it is green. Every other outcome
# is published as success or failure.

: "${RESULTS:?}" "${RUN_ID:?}" "${REPOSITORY:?}" "${RUN_URL:?}"
SHA=${SHA:-}
gh_retry=${GH_RETRY:-"$(dirname "$0")/gh-retry.sh"}

state=failure
if jq -e 'all(.[]; .result == "success")' <<< "$RESULTS" > /dev/null; then
  state=success
elif [[ -n "$SHA" ]] && jq -e \
  'any(.[]; .result == "cancelled") and all(.[]; .result == "success" or .result == "cancelled")' \
  <<< "$RESULTS" > /dev/null; then
  runs=$(bash "$gh_retry" api "repos/$REPOSITORY/actions/workflows/main-pr-depth.yml/runs?per_page=50")
  successor=$(jq -r --arg title "Main PR-depth checks $SHA" --argjson run "$RUN_ID" \
    '[.workflow_runs[] | select(.id > $run and .display_title == $title)
      | if .status != "completed" then "live"
        elif .conclusion == "success" then "green" else empty end]
     | if index("green") then "green" elif index("live") then "live" else "none" end' \
    <<< "$runs")
  if [[ "$successor" == green ]]; then
    echo "A later run for $SHA is green and owns main/pr-depth."
    exit 0
  fi
  if [[ "$successor" == live ]]; then
    # Pending until the live run concludes; a run that dies early stays visible.
    state=pending
  fi
fi

if [[ -n "$SHA" ]]; then
  bash "$gh_retry" api --method POST "repos/$REPOSITORY/statuses/$SHA" \
    -f context=main/pr-depth -f state="$state" \
    -f description="Main PR-depth checks: $state" -f target_url="$RUN_URL"
fi
[[ "$state" == success || "$state" == pending ]]
