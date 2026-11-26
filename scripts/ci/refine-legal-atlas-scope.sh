#!/usr/bin/env bash
set -eo pipefail
changed_files=()
while IFS= read -r -d '' file; do
  changed_files+=("$file")
done < "$RUNNER_TEMP/api-test-changed-paths"
# An unknown diff is already broad; an empty list must preserve it.
required=true
if (( ${#changed_files[@]} > 0 )); then
  required=$(timeout --kill-after=10s 120s bun scripts/legal-atlas-image-scope.ts "${changed_files[@]}") || required=true
fi
if [[ "$required" != false ]]; then
  required=true
fi
echo "api_source_required=$required" >> "$GITHUB_OUTPUT"
