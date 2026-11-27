#!/usr/bin/env bash
set -eo pipefail
file="$RUNNER_TEMP/postgres-test-durations.json"
if [[ "$EXPECTED_HASH" == missing ]]; then
  [[ ! -f "$file" ]] || { echo "Postgres test duration plan unexpectedly exists" >&2; exit 1; }
else
  [[ -f "$file" ]] || { echo "Postgres test duration plan is missing" >&2; exit 1; }
  actual_hash=$(sha256sum "$file" | cut -d ' ' -f 1)
  [[ "$actual_hash" == "$EXPECTED_HASH" ]] || { echo "Postgres test duration plan hash mismatch" >&2; exit 1; }
fi
