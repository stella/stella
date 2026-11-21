#!/usr/bin/env bash
#
# Print the release tag a desktop release run publishes.
#
# A manual dispatch names the tag in its release_ref input. A run started by
# Release Artifacts reads the tag from the one release-manifest-<tag> artifact
# that run uploaded. The upstream run's head branch is never consulted: a
# dispatched Release Artifacts run reports the branch it was dispatched from
# (main), not the tag it published.
#
# Usage: desktop-release-ref.sh <release_ref input> <upstream run id>
# Needs GH_RETRY_SCRIPT and GITHUB_REPOSITORY. The caller validates the tag.
set -euo pipefail

release_input=$1
upstream_run_id=$2

if [[ -n "$release_input" ]]; then
  printf '%s\n' "$release_input"
  exit 0
fi

if [[ ! "$upstream_run_id" =~ ^[0-9]+$ ]]; then
  echo "::error::Expected a release_ref input or the Release Artifacts run id; got '$upstream_run_id'" >&2
  exit 1
fi

artifacts=$(bash "$GH_RETRY_SCRIPT" api "repos/${GITHUB_REPOSITORY}/actions/runs/${upstream_run_id}/artifacts?per_page=100")
manifests=$(jq -r '.artifacts[].name | select(startswith("release-manifest-"))' <<< "$artifacts")
count=$(grep -c . <<< "$manifests" || true)
if [[ "$count" != 1 ]]; then
  echo "::error::Release Artifacts run $upstream_run_id has $count release-manifest artifacts; expected exactly one. Dispatch this workflow with release_ref=<tag> instead." >&2
  exit 1
fi
printf '%s\n' "${manifests#release-manifest-}"
