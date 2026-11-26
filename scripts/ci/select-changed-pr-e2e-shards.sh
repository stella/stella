#!/usr/bin/env bash
set -euo pipefail
: "${RUNNER_TEMP:?RUNNER_TEMP must name the runner temporary directory}"
# An unknown change set selects every leg.
changed_files=()
[[ "${SCOPE_UNKNOWN:-false}" != true ]] || changed_files+=(--all)
if [[ -s "$RUNNER_TEMP/api-test-changed-paths" ]]; then
  while IFS= read -r -d '' file; do
    changed_files+=("$file")
  done < "$RUNNER_TEMP/api-test-changed-paths"
fi
plan=$(bun scripts/e2e-spec-shards.ts select "${changed_files[@]}")
printf '%s\n' "$plan" > "$RUNNER_TEMP/e2e-pr-selection.json"
matrix=$(jq -c .matrix <<< "$plan")
mode=$(jq -r .status <<< "$plan")
specs=$(jq -c .specs <<< "$plan")
{
  echo "matrix=$matrix"
  echo "mode=$mode"
  echo "specs=$specs"
} >> "$GITHUB_OUTPUT"
