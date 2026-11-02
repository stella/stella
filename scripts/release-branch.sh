#!/usr/bin/env bash
# The one owner of the release branch name. The release cut
# (scripts/prepare-maintenance-release.ts) creates this branch, and the release
# source check (scripts/check-release-source-on-main.sh) accepts a merged pull
# request only from it. Source this file for `release_branch`, or run it with a
# version (`bash scripts/release-branch.sh 1.2.3` prints `release/v1.2.3`).

release_branch() {
  local version=${1:-}
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "release_branch: expected a X.Y.Z version, got '${version}'" >&2
    return 1
  fi
  printf 'release/v%s\n' "$version"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  release_branch "${1:-}"
fi
