#!/usr/bin/env bash
set -euo pipefail

attempts="${BUN_CI_ATTEMPTS:-2}"
delay_seconds="${BUN_CI_RETRY_DELAY_SECONDS:-10}"

if [[ ! "$attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "BUN_CI_ATTEMPTS must be a positive integer" >&2
  exit 2
fi

if [[ ! "$delay_seconds" =~ ^[0-9]+$ ]]; then
  echo "BUN_CI_RETRY_DELAY_SECONDS must be a non-negative integer" >&2
  exit 2
fi

for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  if bun ci "$@"; then
    exit 0
  else
    status=$?
  fi

  if ((attempt == attempts)); then
    exit "$status"
  fi

  echo "::warning::bun ci failed on attempt $attempt/$attempts; retrying in ${delay_seconds}s"
  sleep "$delay_seconds"
done
