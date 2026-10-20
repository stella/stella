#!/usr/bin/env bash
set -euo pipefail

property_suites=(
  src/compact-screening.property.test.ts
  src/name-match.property.test.ts
  src/flood-screening.test.ts
)

output="$(mktemp)"
trap 'rm -f "$output"' EXIT

for suite in "${property_suites[@]}"; do
  : >"$output"
  bun test --preload @stll/property-testing/preload "$suite" "$@" 2>&1 | tee "$output"
  if ! grep -Eq '^[[:space:]]*[1-9][0-9]* pass$' "$output"; then
    echo "Property suite reported zero passing tests: $suite" >&2
    exit 1
  fi
done
