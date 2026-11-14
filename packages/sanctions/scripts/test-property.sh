#!/usr/bin/env bash
set -euo pipefail

property_suites=(
  src/compact-screening.property.test.ts
  src/name-match.property.test.ts
  src/flood-screening.test.ts
)

runner_args=("$1" "$2")
shift 2
selected_suites=()
while IFS= read -r suite; do
  selected_suites+=("$suite")
done < <(printf '%s\n' "$@" | sort)
expected_suites=()
while IFS= read -r suite; do
  expected_suites+=("$suite")
done < <(printf '%s\n' "${property_suites[@]}" | sort)
if [[ "${selected_suites[*]}" != "${expected_suites[*]}" ]]; then
  echo "Property selector does not match the explicit suite list" >&2
  exit 1
fi

output="$(mktemp)"
trap 'rm -f "$output"' EXIT

for suite in "${property_suites[@]}"; do
  : >"$output"
  bun test "${runner_args[@]}" "$suite" 2>&1 | tee "$output"
  if ! grep -Eq '^[[:space:]]*[1-9][0-9]* pass$' "$output"; then
    echo "Property suite reported zero passing tests: $suite" >&2
    exit 1
  fi
done
