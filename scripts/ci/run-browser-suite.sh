#!/usr/bin/env bash
set -eo pipefail
suite="$1"
pkg="$2"
script="$3"
if [[ "$EVENT_NAME" != "pull_request" ]]; then
  bun --filter "$pkg" "$script"
  exit 0
fi
listed=$(bun scripts/ci-browser-suites.ts specs "$suite")
[[ -n "$listed" ]] || { echo "No changed specs in this suite."; exit 0; }
mapfile -t specs <<< "$listed"
bun --filter "$pkg" "$script" -- "${specs[@]}"
