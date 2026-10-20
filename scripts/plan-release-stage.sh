#!/usr/bin/env bash
# Bind release staging to the queue entry, and proof inheritance to its range.
set -euo pipefail

required=false
is_release=false
number="${PR_NUMBER:-}"
if [[ "${EVENT_NAME:-}" == merge_group ]]; then
  [[ "${MERGE_GROUP_HEAD_REF:-}" =~ ^refs/heads/gh-readonly-queue/main/pr-([0-9]+)-[0-9a-f]+$ ]] \
    || { echo '::error::RELEASE_STAGE_PLAN_REFUSED: invalid queue entry ref' >&2; exit 1; }
  number="${BASH_REMATCH[1]}"
fi
if [[ -n "$number" ]]; then
  state=$(bash "$(dirname "$0")/release-pull-requests.sh" --repo "${GITHUB_REPOSITORY:?}" --number "$number")
  is_release=$(sed -n 's/^current_is_release=//p' <<< "$state")
  [[ "$is_release" == true || "$is_release" == false ]] \
    || { echo '::error::RELEASE_STAGE_PLAN_REFUSED: missing release verdict' >&2; exit 1; }
fi
if [[ "${EVENT_NAME:-}" == merge_group && "$is_release" == true ]]; then
  required=true
fi
commits='[]'
if [[ -n "${RELEASE_BASE_SHA:-}" ]]; then
  [[ "$RELEASE_BASE_SHA" =~ ^[0-9a-f]{40}$ && "${RELEASE_HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]] \
    || { echo '::error::RELEASE_STAGE_PLAN_REFUSED: invalid comparison commits' >&2; exit 1; }
  git merge-base --is-ancestor "$RELEASE_BASE_SHA" "$RELEASE_HEAD_SHA"
  # The first-parent queue commits are the identities main fast-forwards to;
  # original PR commits on secondary parents cannot carry the staging receipt.
  versions=$(git log --first-parent --format=%H "$RELEASE_BASE_SHA..$RELEASE_HEAD_SHA" -- VERSION)
  commits=$(jq -Rsc 'split("\n") | map(select(length > 0))' <<< "$versions")
fi
printf 'release_stage_required=%s\nrelease_pr_required=%s\nrelease_version_commits=%s\n' "$required" "$is_release" "$commits"
