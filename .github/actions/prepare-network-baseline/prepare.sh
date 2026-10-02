#!/usr/bin/env bash
set -euo pipefail
[[ "$BASE_SHA" =~ ^[a-f0-9]{40}$ ]]
git fetch --no-tags origin "$BASE_SHA"
# Checkout is the tested merge commit. Compute the actual common ancestor,
# rather than reading the mutable tip of main during a long-lived PR.
base=$(git merge-base HEAD "$BASE_SHA")
git show "$base:apps/web/e2e/network-baseline.json" > apps/web/e2e/.network-baseline-base.json
git show "$base:apps/web/src/routeTree.gen.ts" > apps/web/e2e/.network-baseline-base-tree.ts
git diff --name-only --no-renames "$base" HEAD > apps/web/e2e/.network-baseline-changed
recorded=false
load_recording() {
  local source=$1 name artifacts id run_id run
  name="network-baseline-main-$source"
  artifacts=$(gh api --method GET "repos/$REPOSITORY/actions/artifacts" -f name="$name" -f per_page=100)
  # Only the delivery workflow can publish an authoritative artifact. Reject
  # same-name artifacts uploaded by a different workflow, including PR CI.
  while IFS=$'\t' read -r id run_id; do
    [[ -n "$id" ]] || continue
    run=$(gh api "repos/$REPOSITORY/actions/runs/$run_id")
    if ! jq -e '.path == ".github/workflows/network-baseline-deliver.yml" and .event == "workflow_run" and .conclusion == "success" and .head_branch == "main"' <<< "$run" >/dev/null; then
      continue
    fi
    artifact_dir=$(mktemp -d "$RUNNER_TEMP/main-baseline.XXXXXX")
    gh api "repos/$REPOSITORY/actions/artifacts/$id/zip" > "$artifact_dir/baseline.zip"
    unzip -q "$artifact_dir/baseline.zip" -d "$artifact_dir/data"
    bun scripts/network-baseline-scope.ts validate "$artifact_dir/data/network-baseline.json"
    cp "$artifact_dir/data/network-baseline.json" apps/web/e2e/.network-baseline-base.json
    rm -r "$artifact_dir"
    echo "Network baseline: validated main recording at $source (merge base $base)" >> "$GITHUB_STEP_SUMMARY"
    recorded=true
    return
  done < <(jq -r --arg name "$name" '.artifacts | sort_by(.id) | reverse | .[] | select(.name == $name and .expired == false) | [.id, .workflow_run.id] | @tsv' <<< "$artifacts")
}
load_recording "$base"
if [[ "$recorded" == false ]]; then
  # A docs-only main commit has no new recording. Inherit the newest published
  # ancestor, exactly as a committed baseline would be inherited on main.
  runs=$(gh api --method GET "repos/$REPOSITORY/actions/workflows/network-baseline-record.yml/runs" -f branch=main -f status=success -f per_page=100)
  while read -r source; do
    [[ "$source" =~ ^[a-f0-9]{40}$ ]] || continue
    if [[ "$source" == "$base" ]] || ! git merge-base --is-ancestor "$source" "$base"; then
      continue
    fi
    load_recording "$source"
    if [[ "$recorded" == true ]]; then break; fi
  done < <(jq -r '.workflow_runs[] | select(.event == "push" or .event == "schedule" or .event == "workflow_dispatch") | .head_sha' <<< "$runs")
fi
# Bootstrap/retention fallback is pinned to the same merge base, never PR JSON.
if [[ "$recorded" == false ]]; then
  echo "Network baseline: committed bootstrap at merge base $base (recording unavailable)" >> "$GITHUB_STEP_SUMMARY"
fi
bun scripts/network-baseline-scope.ts prepare \
  --base apps/web/e2e/.network-baseline-base.json \
  --changed apps/web/e2e/.network-baseline-changed \
  --base-route-tree apps/web/e2e/.network-baseline-base-tree.ts \
  --route-tree apps/web/src/routeTree.gen.ts \
  --output apps/web/e2e/network-baseline.json \
  --context apps/web/e2e/.network-baseline-context.json >> "$GITHUB_STEP_SUMMARY"
