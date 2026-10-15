#!/usr/bin/env bash
# Read the pending release from main, independent of the caller's checkout.
set -euo pipefail

gh_retry_script="${GH_RETRY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/gh-retry.sh}"
if [[ $# != 2 || "$1" != "--repo" || -z "$2" ]]; then
  echo "usage: release-pending.sh --repo <owner/name>" >&2
  exit 2
fi
repo="$2"
version=$(bash "$gh_retry_script" api "repos/$repo/contents/VERSION?ref=main" --jq '.content' | base64 --decode | tr -d '[:space:]')
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(rc|beta|alpha)\.[0-9]+)?$ ]]; then
  echo "::error::Invalid VERSION on main: $version" >&2
  exit 1
fi
# Prefix matches include prereleases; only the exact ref closes this window.
refs=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/git/matching-refs/tags/v$version")
state=$(jq -r --arg tag "refs/tags/v$version" \
  'if any(.[][]; .ref == $tag) then "tagged" else "pending" end' <<<"$refs")
printf 'version_state=%s\nversion=%s\n' "$state" "$version"
