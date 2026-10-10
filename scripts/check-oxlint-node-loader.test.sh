#!/usr/bin/env bash
set -euo pipefail

set +e
probe_output=$(bash scripts/check-oxlint-node-loader.sh \
  scripts/__fixtures__/oxlint-node-loader-error.config.ts \
  .oxlint-plugins/physical-properties.ts 2>&1)
status=$?
set -e

if [[ $status -eq 0 ]]; then
  echo "check-oxlint-node-loader self-test: loader failure passed" >&2
  exit 1
fi

if grep -qE "Failed to load JS plugin|ERR_MODULE_NOT_FOUND" <<<"$probe_output"; then
  echo "check-oxlint-node-loader self-test: fixture reached the old output filter" >&2
  exit 1
fi

if ! grep -q "injected Node loader failure" <<<"$probe_output"; then
  echo "check-oxlint-node-loader self-test: injected failure was not observed" >&2
  echo "$probe_output" >&2
  exit 1
fi
