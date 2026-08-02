#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
script="$repo_root/scripts/create-release-manifest.sh"
api_digest="sha256:$(printf 'a%.0s' {1..64})"
web_digest="sha256:$(printf 'b%.0s' {1..64})"
manifest="$(
  cd "$repo_root"
  bash "$script" \
    "v1.2.3" \
    "ghcr.io/stella/stella-api" \
    "$api_digest" \
    "ghcr.io/stella/stella-web" \
    "$web_digest" \
    "production"
)"

jq -e \
  --arg api_digest "$api_digest" \
  --arg commit "$(git -C "$repo_root" rev-parse HEAD)" \
  --arg web_digest "$web_digest" \
  '.version == "v1.2.3"
    and .commit == $commit
    and .image.digest == $api_digest
    and .image.reference == ("ghcr.io/stella/stella-api@" + $api_digest)
    and .webImage.digest == $web_digest
    and .webImage.reference == ("ghcr.io/stella/stella-web@" + $web_digest)
    and .webImage.targetEnvironment == "production"' \
  <<<"$manifest" >/dev/null

if (
  cd "$repo_root"
  bash "$script" \
    "v1.2.3" \
    "ghcr.io/stella/stella-api" \
    "$api_digest" \
    "ghcr.io/stella/stella-web" \
    "latest" \
    "production" >/dev/null 2>&1
); then
  echo "create-release-manifest accepted a mutable web image reference." >&2
  exit 1
fi

echo "create-release-manifest tests passed"
