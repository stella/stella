#!/usr/bin/env bash
set -euo pipefail
base_sha=$(git merge-base origin/main HEAD)
name="typecheck-base-v1-$base_sha"
base_dir="$RUNNER_TEMP/typecheck-base"
recording_unavailable() {
  echo "::warning::Typecheck baseline: $1; measuring exact base $base_sha." >&2
}
if ! artifacts=$(gh api --method GET "repos/$REPOSITORY/actions/artifacts" -f name="$name" -f per_page=100); then
  recording_unavailable "recording lookup unavailable"
  artifacts='{"artifacts":[]}'
fi
if ! candidates=$(jq -r --arg name "$name" '.artifacts | sort_by(.id) | reverse | .[] | select(.name == $name and .expired == false) | [.id, .workflow_run.id] | @tsv' <<< "$artifacts"); then
  recording_unavailable "recording lookup response invalid"
  candidates=""
fi
while IFS=$'\t' read -r id run_id; do
  [[ -n "$id" ]] || continue
  if ! run=$(gh api "repos/$REPOSITORY/actions/runs/$run_id"); then
    recording_unavailable "recording workflow metadata unavailable"
    continue
  fi
  if ! jq -e --arg sha "$base_sha" '.path == ".github/workflows/typecheck-base.yml" and .event == "push" and .conclusion == "success" and .head_branch == "main" and .head_sha == $sha' <<< "$run" >/dev/null; then
    continue
  fi
  bundle=$(mktemp -d "$RUNNER_TEMP/typecheck-recording.XXXXXX")
  if ! gh api "repos/$REPOSITORY/actions/artifacts/$id/zip" > "$bundle/recording.zip"; then
    recording_unavailable "recording download unavailable"
    continue
  fi
  if ! unzip -q "$bundle/recording.zip" -d "$bundle/data"; then
    recording_unavailable "recording archive invalid"
    continue
  fi
  if [[ ! -f "$bundle/data/sha" ]] ||
    [[ "$(cat "$bundle/data/sha")" != "$base_sha" ]] ||
    [[ ! -s "$bundle/data/typecheck-base.json" ]] ||
    [[ ! -f "$bundle/data/api-routes.gen.ts" ]] ||
    [[ ! -f "$bundle/data/routeTree.gen.ts" ]]; then
    recording_unavailable "recording payload invalid"
    continue
  fi
  mkdir -p "$base_dir/apps/web/src/generated"
  cp "$bundle/data/typecheck-base.json" "$RUNNER_TEMP/typecheck-base.json"
  cp "$bundle/data/api-routes.gen.ts" "$base_dir/apps/web/src/generated/api-routes.gen.ts"
  cp "$bundle/data/routeTree.gen.ts" "$base_dir/apps/web/src/routeTree.gen.ts"
  echo "Typecheck baseline: main recording at $base_sha" >> "$GITHUB_STEP_SUMMARY"
  exit 0
done <<< "$candidates"
# Bootstrap and expired artifacts retain the exact-base comparison, never a
# nearby commit or a baseline uploaded by pull request code.
echo "Typecheck baseline: recording unavailable; measuring $base_sha" >> "$GITHUB_STEP_SUMMARY"
git worktree add --detach "$base_dir" "$base_sha"
git -C "$base_dir" submodule update --init --recursive
(
  cd "$base_dir"
  unset CI_GENERATED_SOURCES_MANIFEST
  bash scripts/retry.sh bun ci --ignore-scripts
  # Older merge bases still commit the runtime aggregates.
  if [[ -f apps/api/scripts/generate-capability-runtime.ts ]]; then
    bun --filter @stll/api generate:capability-runtime
  fi
  # Older bases commit the snapshot. Generate only when the base
  # owns an untracked output, using its cached producer if present.
  if [[ ! -f apps/web/src/generated/api-routes.gen.ts ]]; then
    if bun -e 'process.exit("generate" in require("./package.json").scripts ? 0 : 1)'; then
      bun run generate
    else
      bun --filter @stll/api gen:web-api-types
    fi
  fi
  if [[ ! -f apps/web/src/routeTree.gen.ts ]]; then
    bun --filter @stll/web generate:route-tree
  fi
  bun run typegen
)
bun scripts/typecheck-baseline.ts --measure "$base_dir" "$RUNNER_TEMP/typecheck-base.json"
