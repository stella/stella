#!/usr/bin/env bash
set -euo pipefail

# Publishes the main/pr-depth commit status for one Main PR-depth run.
# A run whose suites were cancelled writes nothing when a later run for the same
# commit is live or green: that run always publishes, so this one can never
# overwrite its result. Every other outcome is published as success or failure.

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
    'any(.workflow_runs[]; .id > $run and .display_title == $title
      and (.status != "completed" or .conclusion == "success"))' \
    <<< "$runs" > /dev/null; then
    echo "A later run for $SHA is live or green and publishes main/pr-depth."
    exit 0
  fi
fi

if [[ -n "$SHA" ]]; then
  bash "$gh_retry" api --method POST "repos/$REPOSITORY/statuses/$SHA" \
    -f context=main/pr-depth -f state="$state" \
    -f description="Main PR-depth checks: $state" -f target_url="$RUN_URL"
fi
[[ "$state" == success ]]
