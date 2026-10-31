#!/usr/bin/env bash
set -euo pipefail

if (($# < 3)); then
  echo 'usage: upload-release-assets.sh REPOSITORY TAG FILE...' >&2
  exit 2
fi
repository=$1
tag=$2
shift 2
script_dir=$(cd "$(dirname "$0")" && pwd)
GH_RETRY_SCRIPT=${GH_RETRY_SCRIPT:-$script_dir/gh-retry.sh}
request_timeout_seconds=60
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

for file in "$@"; do
  name=$(basename "$file")
  if [[ ! -f "$file" || ! "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    echo "Invalid release asset file: $file" >&2
    exit 1
  fi
  local_digest=$(shasum -a 256 < "$file")
  for attempt in 1 2 3 4; do
    # A failed upload may have reached GitHub. Reconcile before retrying it.
    names=$(timeout "$request_timeout_seconds" bash "$GH_RETRY_SCRIPT" release view "$tag" --repo "$repository" --json assets --jq '.assets[].name')
    if printf '%s\n' "$names" | grep -Fx -- "$name" > /dev/null; then
      rm -rf "$scratch/remote"
      timeout "$request_timeout_seconds" bash "$GH_RETRY_SCRIPT" release download "$tag" --repo "$repository" --pattern "$name" --dir "$scratch/remote"
      remote_digest=$(shasum -a 256 < "$scratch/remote/$name")
      if [[ "$remote_digest" != "$local_digest" ]]; then
        echo "Refusing to replace published release asset $name: SHA-256 differs from local file" >&2
        exit 1
      fi
      echo "Skipping identical published release asset $name"
      break
    fi
    if ((attempt == 4)); then
      echo "Failed to upload missing release asset $name after 3 attempts" >&2
      exit 1
    fi
    if timeout "$request_timeout_seconds" bash "$GH_RETRY_SCRIPT" release upload "$tag" --repo "$repository" "$file"; then
      break
    fi
    sleep "$attempt"
  done
done
