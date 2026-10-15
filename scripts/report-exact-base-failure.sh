#!/usr/bin/env bash
set -euo pipefail

gh_retry_script="${GH_RETRY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/gh-retry.sh}"

: "${REPOSITORY:?REPOSITORY is required}"
: "${RUN_URL:?RUN_URL is required}"
: "${DRY_RUN:?DRY_RUN must be true or false}"
[[ "$REPOSITORY" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]] || exit 1
[[ "$RUN_URL" == "https://github.com/$REPOSITORY/actions/runs/"* ]] || exit 1
[[ "${RUN_URL##*/}" =~ ^[0-9]+$ ]] || exit 1
[[ "$DRY_RUN" == true || "$DRY_RUN" == false ]] || exit 1

label=routine-fixes
title=migration-exact-base-upgrade
body=$(printf "Job: \`%s\`\n\nRun: %s\n" "$title" "$RUN_URL")

# List REST results rather than search-index results; recurring failures update
# the same open issue. The workflow serializes this read/write transaction.
issue=$(bash "$gh_retry_script" api "repos/$REPOSITORY/issues?state=open&labels=$label&per_page=100" \
  --paginate --slurp \
  | jq -r "[.[][] | select(.title == \"$title\" and .pull_request == null)] | min_by(.number) | .number // empty")

if [[ "$DRY_RUN" == true ]]; then
  printf 'Dry run: %s issue %s\n\n%s\n' "${issue:+update}" "${issue:-create}" "$body" \
    | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 0
fi

if [[ -n "$issue" ]]; then
  [[ "$issue" =~ ^[0-9]+$ ]] || exit 1
  bash "$gh_retry_script" api --method PATCH "repos/$REPOSITORY/issues/$issue" -f body="$body" --silent
  exit 0
fi

has_label=$(bash "$gh_retry_script" api "repos/$REPOSITORY/labels?per_page=100" --paginate --slurp \
  | jq "[.[][] | select(.name == \"$label\")] | length")
if [[ "$has_label" == 0 ]]; then
  bash "$gh_retry_script" api --method POST "repos/$REPOSITORY/labels" -f name="$label" -f color=ededed --silent
fi

# A JSON body preserves newlines and supplies labels as an array.
jq -n --arg title "$title" --arg body "$body" --arg label "$label" \
  '{title: $title, body: $body, labels: [$label]}' \
  | bash "$gh_retry_script" api --method POST "repos/$REPOSITORY/issues" --input - --silent
