#!/usr/bin/env bash
set -euo pipefail

artifact_root="$1"
consumer_directory="$2"
retry_script="$3"
shopt -s nullglob
tarballs=("$artifact_root"/*/*.tgz)
if (( ${#tarballs[@]} == 0 )); then
  echo "No packed npm packages found in $artifact_root" >&2
  exit 1
fi

# Only declared runtime dependencies may expose same-release artifacts to the
# consumer. Installing every artifact directly would hide undeclared CLI imports.
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun "$script_directory/prepare-packed-cli-consumer.ts" "$consumer_directory" "${tarballs[@]}"
cd "$consumer_directory"
bash "$retry_script" npm install --ignore-scripts --no-audit --no-fund
