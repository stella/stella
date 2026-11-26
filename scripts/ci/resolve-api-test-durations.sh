#!/usr/bin/env bash
set -eo pipefail
key="$MATCHED_KEY"
[[ -n "$key" ]] || key="api-test-durations-$GITHUB_RUN_ID"
echo "key=$key" >> "$GITHUB_OUTPUT"
if [[ -f "$RUNNER_TEMP/api-test-durations.json" ]]; then
  echo "hash=$(sha256sum "$RUNNER_TEMP/api-test-durations.json" | cut -d ' ' -f 1)" >> "$GITHUB_OUTPUT"
else
  echo "hash=missing" >> "$GITHUB_OUTPUT"
fi
echo "API_TEST_DURATIONS_FILE=$RUNNER_TEMP/api-test-durations.json" >> "$GITHUB_ENV"
