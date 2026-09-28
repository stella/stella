#!/usr/bin/env bash
# Report the open release pull requests, as GitHub output lines.
#
# A release is recognized only as a ready pull request into main whose head
# branch lives in this repository (pushing one takes write access) and whose
# title starts with "chore: release v". Both the Version Packages workflow and
# the merge queue's release hold read releases through this one rule.
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

# The search narrows the listing to release titles on the server, so the limit
# counts candidates only, never unrelated open pull requests.
releases=$(gh pr list --repo "$repo" --state open --base main \
  --search '"chore: release v" in:title' \
  --limit 100 --json number,title,isDraft,isCrossRepository \
  --jq '[
    .[]
    | select(.title | startswith("chore: release v"))
    | select(.isDraft | not)
    | select(.isCrossRepository | not)
    | .number
  ] | map(tostring) | join(" ")')

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
