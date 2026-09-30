#!/usr/bin/env bash
# Report the open release pull requests, as GitHub output lines.
#
# A release is recognized only as a ready pull request into main whose head
# branch lives in this repository (pushing one takes write access) and whose
# title starts with "chore: release v". Both the Version Packages workflow and
# the merge queue's release hold read releases through this one rule. List open
# pull requests directly so recognition does not depend on the search index.
#
# Usage: release-pull-requests.sh --repo <owner/name> [--number <pull request>]
# Prints:
#   open_other=<count of release pull requests other than --number>
#   current_is_release=<true when --number is itself a release pull request>
set -euo pipefail

repo=""
number=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      repo="${2:?--repo needs a value}"
      shift 2
      ;;
    --number)
      number="${2:?--number needs a value}"
      shift 2
      ;;
    *)
      echo "usage: release-pull-requests.sh --repo <owner/name> [--number <n>]" >&2
      exit 2
      ;;
  esac
done
if [[ -z "$repo" ]]; then
  echo "usage: release-pull-requests.sh --repo <owner/name> [--number <n>]" >&2
  exit 2
fi
if [[ -n "$number" && ! "$number" =~ ^[0-9]+$ ]]; then
  echo "release-pull-requests.sh: --number must be a pull request number" >&2
  exit 2
fi

# A complete listing is required before reporting that no release is open.
listing_limit=500
pull_requests=$(gh pr list --repo "$repo" --state open --base main \
  --limit "$listing_limit" --json number,title,isDraft,isCrossRepository)
if [[ "$(jq 'length' <<<"$pull_requests")" -ge "$listing_limit" ]]; then
  echo "release-pull-requests.sh: open pull request listing reached the $listing_limit limit; refusing partial release state" >&2
  exit 1
fi
releases=$(jq -r '[
    .[]
    | select(.title | startswith("chore: release v"))
    | select(.isDraft | not)
    | select(.isCrossRepository | not)
    | .number
  ] | map(tostring) | join(" ")' <<<"$pull_requests")

open_other=0
current_is_release=false
for release in $releases; do
  if [[ "$release" == "$number" ]]; then
    current_is_release=true
  else
    open_other=$((open_other + 1))
  fi
done

echo "open_other=$open_other"
echo "current_is_release=$current_is_release"
