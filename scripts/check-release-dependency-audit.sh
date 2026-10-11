#!/usr/bin/env bash
set -euo pipefail

status=0
bun scripts/dependency-audit.ts --release || status=$?
if [[ "$status" -eq 0 ]]; then
  if [[ "${WAIVE_DEPENDENCY_AUDIT:-false}" == "true" ]]; then
    echo "::error::The dependency audit waiver cannot be supplied when the audit passes." >&2
    exit 1
  fi
  exit 0
fi

reason="${WAIVER_REASON:-}"
if [[ "$status" -eq 1 && "${WAIVE_DEPENDENCY_AUDIT:-false}" == "true" && "$reason" =~ [^[:space:]] && "$reason" != *$'\n'* ]]; then
  echo "::warning::Dependency audit explicitly waived: $reason"
  exit 0
fi
exit "$status"
