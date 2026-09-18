#!/usr/bin/env bash
set -euo pipefail

# Runs a command until it succeeds or the attempt budget is exhausted.
# Every wrapped command must be idempotent, because a retry repeats work a
# failed attempt may already have done: `gh release upload` therefore carries
# `--clobber` so a partial upload is overwritten instead of rejected.
#
# Keep this bash 3.2 compatible (no mapfile, no associative arrays): macOS and
# Windows runners invoke it.

attempts="${RETRY_ATTEMPTS:-3}"
delays_seconds="${RETRY_DELAYS_SECONDS:-15 45}"

if [[ $# -eq 0 ]]; then
  echo "usage: retry.sh <command> [args...]" >&2
  exit 2
fi

if [[ ! "$attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "RETRY_ATTEMPTS must be a positive integer" >&2
  exit 2
fi

delays=()
read -ra delays <<<"$delays_seconds"

if ((${#delays[@]} == 0)); then
  echo "RETRY_DELAYS_SECONDS must be a space-separated list of non-negative integers" >&2
  exit 2
fi

for delay in "${delays[@]}"; do
  if [[ ! "$delay" =~ ^[0-9]+$ ]]; then
    echo "RETRY_DELAYS_SECONDS must be a space-separated list of non-negative integers" >&2
    exit 2
  fi
done

for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  if "$@"; then
    exit 0
  else
    status=$?
  fi

  if ((attempt == attempts)); then
    exit "$status"
  fi

  # The last delay repeats once the list is shorter than the attempt budget.
  index=$((attempt < ${#delays[@]} ? attempt : ${#delays[@]}))
  delay="${delays[index - 1]}"

  echo "::warning::$* failed on attempt $attempt/$attempts; retrying in ${delay}s"
  sleep "$delay"
done
