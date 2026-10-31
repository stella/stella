#!/usr/bin/env bash
set -euo pipefail

# Prints the newest first-parent ancestor of SHA whose main/pr-depth status is
# a covered success from a scheduled Main PR-depth run of this repository, or
# nothing. Main's code check compares against it, so a scheduled run checks
# what changed since the last commit known green; printing nothing makes the
# caller check everything. Runs inside a checkout that holds main's history.
#
# Only statuses that main-pr-depth-status.sh marks `code-check=covered` count:
# an older success came from runs whose code check compared main with itself.

: "${REPOSITORY:?}" "${SHA:?}"
gh_retry=${GH_RETRY:-"$(dirname "$0")/gh-retry.sh"}
depth=${GREEN_BASE_DEPTH:-20}
runs_prefix="https://github.com/$REPOSITORY/actions/runs/"

# The status must link to a completed, successful scheduled run of this
# workflow for the commit; another workflow can write a status with this
# context, but not such a run.
run_matches() {
  local commit="$1" url="$2" run_id run
  [[ "$url" == "$runs_prefix"* ]] || return 1
  run_id="${url#"$runs_prefix"}"
  [[ "$run_id" =~ ^[1-9][0-9]*$ ]] || return 1
  run=$(bash "$gh_retry" api "repos/$REPOSITORY/actions/runs/$run_id") || return 1
  jq -e --arg repo "$REPOSITORY" --arg sha "$commit" --arg url "$url" --argjson id "$run_id" '
    .id == $id and .html_url == $url and .repository.full_name == $repo and
    .path == ".github/workflows/main-pr-depth.yml" and .head_branch == "main" and
    .event == "schedule" and .head_sha == $sha and
    .display_title == ("Main PR-depth checks " + $sha) and
    .status == "completed" and .conclusion == "success"
  ' <<< "$run" > /dev/null
}

while read -r candidate; do
  statuses=$(bash "$gh_retry" api "repos/$REPOSITORY/commits/$candidate/statuses?per_page=100")
  # GitHub lists a commit's statuses newest first; the newest one decides.
  status=$(jq -c '[.[] | select(.context == "main/pr-depth")][0] // empty' <<< "$statuses")
  [[ -n "$status" ]] || continue
  if jq -e '.state == "success" and .creator.login == "github-actions[bot]" and .creator.type == "Bot"
    and (.description // "" | contains("code-check=covered"))' <<< "$status" > /dev/null \
    && run_matches "$candidate" "$(jq -r '.target_url // ""' <<< "$status")"; then
    echo "$candidate"
    exit 0
  fi
done < <(git rev-list --first-parent --max-count="$depth" "$SHA^")
