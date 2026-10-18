#!/usr/bin/env bash
# A merge group succeeds only when every queued group ahead of it has passed.
#
# GitHub merges every queue entry ahead of a passing group. Each group plans
# its suites from its own changes, so a later group must not certify entries
# ahead whose own suites are still running or have failed. Each poll re-reads
# the queue, so an ancestor that merged or was rebuilt is judged as it is now.
set -euo pipefail
shopt -s inherit_errexit

if [[ "${EVENT_NAME:-}" != "merge_group" ]]; then
  exit 0
fi
repository="${REPOSITORY:?REPOSITORY is required}"
base_sha="${MERGE_GROUP_BASE_SHA:?MERGE_GROUP_BASE_SHA is required}"
base_branch="${MERGE_GROUP_BASE_REF:?MERGE_GROUP_BASE_REF is required}"
base_branch="${base_branch#refs/heads/}"
wait_seconds="${ANCESTOR_WAIT_SECONDS:-3600}"
poll_seconds="${ANCESTOR_POLL_SECONDS:-60}"
deadline=$(($(date +%s) + wait_seconds))

gh_api() {
  if [[ -n "${GH_RETRY_SCRIPT:-}" ]]; then
    bash "$GH_RETRY_SCRIPT" api "$@"
  else
    gh api "$@"
  fi
}

# One line per queued group ahead, oldest first: "<sha> <subject>".
ancestors() {
  local comparison status
  comparison=$(gh_api "repos/$repository/compare/$base_branch...$base_sha")
  status=$(jq -r '.status' <<<"$comparison")
  case "$status" in
    identical) ;;
    ahead) jq -r '.commits[] | "\(.sha) \(.commit.message | split("\n")[0])"' <<<"$comparison" ;;
    *)
      echo "::error::Merge group base $base_sha is $status relative to $base_branch, so the groups ahead cannot be verified." >&2
      return 1
      ;;
  esac
}

# pending, success, or the failing conclusion of the latest ci-result.
ancestor_state() {
  gh_api "repos/$repository/commits/$1/check-runs?check_name=ci-result&filter=latest&per_page=100" |
    jq -r '[.check_runs[]] | sort_by(.id) | last
      | if . == null then "pending"
        elif .status != "completed" then "pending"
        else .conclusion end'
}

while true; do
  queue=$(ancestors)
  pending=()
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    sha="${line%% *}"
    state=$(ancestor_state "$sha")
    case "$state" in
      success) ;;
      pending) pending+=("$line") ;;
      *)
        echo "::error::Queued group ahead did not pass (ci-result $state): $line" >&2
        exit 1
        ;;
    esac
  done <<<"$queue"
  if ((${#pending[@]} == 0)); then
    echo "Every queued group ahead passed."
    exit 0
  fi
  if (($(date +%s) >= deadline)); then
    for line in "${pending[@]}"; do
      echo "::error::Queued group ahead did not finish within ${wait_seconds}s: $line" >&2
    done
    exit 1
  fi
  echo "Waiting for ${#pending[@]} queued group(s) ahead: ${pending[0]}"
  sleep "$poll_seconds"
done
