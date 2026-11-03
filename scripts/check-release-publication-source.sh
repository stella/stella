#!/usr/bin/env bash
# The upstream run's production receipt owns publication, even if an unrelated
# publication job failed. A run title alone never grants publication authority.
set -euo pipefail
run_id=$1
release_ref=$2
release_sha=$3
[[ "$run_id" =~ ^[0-9]+$ && "$release_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid release run or SHA' >&2; exit 1; }
[[ "$release_ref" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || { echo 'Invalid release ref' >&2; exit 1; }
run=$(bash "$GH_RETRY_SCRIPT" api "repos/$GITHUB_REPOSITORY/actions/runs/$run_id")
jq -e --arg repo "$GITHUB_REPOSITORY" --arg ref "$release_ref" --arg sha "$release_sha" '
  .head_repository.full_name == $repo and .path == ".github/workflows/release.yml" and
  (.event == "push" or .event == "workflow_dispatch") and
  .display_title == ("Release Artifacts " + $ref) and
  (.event != "push" or .head_sha == $sha)
' <<< "$run" >/dev/null || { echo 'Release run does not own the requested ref and SHA' >&2; exit 1; }
[[ "$release_ref" != *-* ]] || { echo 'Production publication requires a stable ref' >&2; exit 1; }
job=promote-production
jobs=$(bash "$GH_RETRY_SCRIPT" api --paginate --slurp "repos/$GITHUB_REPOSITORY/actions/runs/$run_id/jobs?per_page=100")
jq -e --arg job "$job" '[.[].jobs[] | select(.name == $job)] | length == 1 and .[0].conclusion == "success"' <<< "$jobs" >/dev/null || {
  echo "Release run has no successful $job receipt" >&2
  exit 1
}
