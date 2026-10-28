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

# Installing all exact tarballs in one tree makes same-release dependencies
# resolvable before they exist on npm. The artifacts themselves remain unchanged.
cd "$consumer_directory"
npm init -y >/dev/null
bash "$retry_script" npm install --ignore-scripts --no-audit --no-fund "${tarballs[@]}"
