#!/usr/bin/env bash
set -euo pipefail
: "${REPOSITORY:?REPOSITORY is required}"
gh_retry_script="${GH_RETRY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/../../../scripts/gh-retry.sh}"
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
# shellcheck source=.github/actions/prepare-network-baseline/select-recording.sh
source "$(dirname "${BASH_SOURCE[0]}")/select-recording.sh"
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
