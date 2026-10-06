#!/usr/bin/env bash
set -euo pipefail
purpose=${NETWORK_BASELINE_PURPOSE:-comparison}
case "$purpose" in comparison|recording) ;; *) exit 1 ;; esac
[[ "$BASE_SHA" =~ ^[a-f0-9]{40}$ ]]
git fetch --no-tags origin "$BASE_SHA"
# Default to the common ancestor for head checkouts and merge queues.
base=$(git merge-base HEAD "$BASE_SHA")
# GitHub's PR merge ref includes newer main commits than the event's recorded
# base. Its first parent is the main tree actually under test.
read -r -a parents <<< "$(git show -s --format=%P HEAD)"
if [[ "${GITHUB_EVENT_NAME:-}" == pull_request && ${#parents[@]} == 2 ]] &&
  git merge-base --is-ancestor "$BASE_SHA" "${parents[0]}"; then
  base=${parents[0]}
fi
if [[ "$purpose" == recording && "$base" != "$(git rev-parse HEAD)" ]]; then
  echo 'Recording must seed the checked-out main commit' >&2
  exit 1
fi
git show "$base:apps/web/e2e/network-baseline.json" > apps/web/e2e/.network-baseline-base.json
base_tree="$RUNNER_TEMP/base-route-tree.gen.ts"
head_tree="$RUNNER_TEMP/head-route-tree.gen.ts"
repository=$(git rev-parse --show-toplevel)
head=$(git rev-parse HEAD)
bun apps/web/scripts/network-baseline-route-tree.ts "$repository" "$head" "$head_tree"
recorded=false
recorded_source=''
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
    recorded_source=$source
    return
  done < <(jq -r --arg name "$name" '.artifacts | sort_by(.id) | reverse | .[] | select(.name == $name and .expired == false) | [.id, .workflow_run.id] | @tsv' <<< "$artifacts")
}
load_recording "$base"
if [[ "$recorded" == false ]]; then
  # A docs-only main commit has no new recording. Inherit the newest published
  # ancestor, exactly as a committed baseline would be inherited on main.
  runs=$(gh api --method GET "repos/$REPOSITORY/actions/workflows/network-baseline-record.yml/runs" -f branch=main -f status=success -f per_page=100)
  candidates=$(jq -r '.workflow_runs[] | select(.event == "push" or .event == "schedule" or .event == "workflow_dispatch") | .head_sha' <<< "$runs")
  while read -r source; do
    if [[ "$source" == "$base" ]]; then
      continue
    fi
    case $'\n'"$candidates"$'\n' in
      *$'\n'"$source"$'\n'*) ;;
      *) continue ;;
    esac
    load_recording "$source"
    if [[ "$recorded" == true ]]; then break; fi
  done < <(git rev-list --topo-order "$base")
fi
# Bootstrap/retention fallback is pinned to the same merge base, never PR JSON.
if [[ "$recorded" == false ]]; then
  echo "Network baseline: committed bootstrap at merge base $base (recording unavailable)" >> "$GITHUB_STEP_SUMMARY"
fi
since=$base
if [[ "$purpose" == comparison && "$recorded" == true && "$recorded_source" != "$base" ]]; then
  # Routes changed after the inherited recording have no recorded peak yet.
  since=$recorded_source
  if ! git merge-base --is-ancestor "$since" "$base"; then
    echo "Network baseline: recording source $since is not an ancestor of $base" >&2
    exit 1
  fi
  # Main records daily and after each route change merges, so an older source
  # means recording has stalled; exempting everything since then would not.
  max_recording_lag_seconds=$((36 * 60 * 60))
  lag=$(($(git show -s --format=%ct "$base") - $(git show -s --format=%ct "$since")))
  if ((lag > max_recording_lag_seconds)); then
    echo "Network baseline: recording stale since $since" >> "$GITHUB_STEP_SUMMARY"
    echo "Network baseline: recording stale since $since (${lag}s behind $base); record main before comparing" >&2
    exit 1
  fi
fi
bun apps/web/scripts/network-baseline-route-tree.ts "$repository" "$since" "$base_tree"
if [[ "$since" == "$base" ]]; then
  git diff --name-only --no-renames "$base" HEAD > apps/web/e2e/.network-baseline-changed
else
  # Main's own baseline edits before the merge base are not PR edits.
  {
    git diff --name-only --no-renames "$since" "$base" -- . ':(exclude)apps/web/e2e/network-baseline.json'
    git diff --name-only --no-renames "$base" HEAD
  } | sort -u > apps/web/e2e/.network-baseline-changed
fi
if [[ "$purpose" == comparison ]]; then
  echo "Network baseline: comparison exempts routes changed since $since" >> "$GITHUB_STEP_SUMMARY"
fi
if [[ "$purpose" == recording ]]; then
  # Each reviewed main commit can replace a route's declaration. Replay only
  # commits after the seed, in order, so inherited files cannot reset later peaks.
  declaration_base=${recorded_source:-$(git log -1 --format=%H "$base" -- apps/web/e2e/network-baseline.json)}
  while read -r commit; do
    git diff-tree --no-commit-id --name-only -r "$commit" -- apps/web/e2e/network-budgets > apps/web/e2e/.network-baseline-declarations
    bun scripts/network-baseline-scope.ts prepare \
      --base apps/web/e2e/.network-baseline-base.json \
      --changed apps/web/e2e/.network-baseline-declarations \
      --base-route-tree "$base_tree" \
      --route-tree "$head_tree" \
      --output apps/web/e2e/network-baseline.json \
      --context apps/web/e2e/.network-baseline-context.json >> "$GITHUB_STEP_SUMMARY"
    cp apps/web/e2e/network-baseline.json apps/web/e2e/.network-baseline-base.json
  done < <(git log --reverse --format=%H "$declaration_base..HEAD" -- apps/web/e2e/network-budgets)
fi
bun scripts/network-baseline-scope.ts prepare \
  --base apps/web/e2e/.network-baseline-base.json \
  --changed apps/web/e2e/.network-baseline-changed \
  --base-route-tree "$base_tree" \
  --route-tree "$head_tree" \
  --output apps/web/e2e/network-baseline.json \
  --context apps/web/e2e/.network-baseline-context.json >> "$GITHUB_STEP_SUMMARY"
