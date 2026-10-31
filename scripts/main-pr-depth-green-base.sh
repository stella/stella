#!/usr/bin/env bash
set -euo pipefail

# Prints the newest first-parent ancestor of SHA whose main/pr-depth status is
# a success published by this repository's workflow, or nothing. Main's code
# check compares against it, so a scheduled run checks what changed since the
# last commit known green; printing nothing makes the caller check everything.
# Runs inside a checkout that holds main's history.

: "${REPOSITORY:?}" "${SHA:?}"
gh_retry=${GH_RETRY:-"$(dirname "$0")/gh-retry.sh"}
depth=${GREEN_BASE_DEPTH:-50}

while read -r candidate; do
  statuses=$(bash "$gh_retry" api "repos/$REPOSITORY/commits/$candidate/statuses?per_page=100")
  # GitHub lists a commit's statuses newest first; the newest one decides.
  state=$(jq -r '[.[] | select(.context == "main/pr-depth" and .creator.login == "github-actions[bot]")][0].state // ""' <<< "$statuses")
  if [[ "$state" == success ]]; then
    echo "$candidate"
    exit 0
  fi
done < <(git rev-list --first-parent --max-count="$depth" "$SHA^")
