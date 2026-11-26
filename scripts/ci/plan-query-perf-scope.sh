#!/usr/bin/env bash
set -eo pipefail
if [[ "$HEAVY_ONLY" == true ]]; then
  echo "query_perf_required=true" >> "$GITHUB_OUTPUT"
  exit 0
fi
QUERY_PERF_CHANGED_PATHS="$CHANGED_PATHS" QUERY_PERF_SCOPE_UNKNOWN="$SCOPE_UNKNOWN" \
  bun scripts/query-perf-scope.ts >> "$GITHUB_OUTPUT"
