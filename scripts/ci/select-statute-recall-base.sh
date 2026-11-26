#!/usr/bin/env bash
set -eo pipefail
base="${TARGET_BASE_SHA:-$PUSH_BEFORE_SHA}"
if [[ -z "$base" || "$base" =~ ^0+$ ]]; then
  bash "${GITHUB_WORKSPACE}/scripts/retry.sh" git fetch --no-tags --depth=1 origin main
  base="$(git rev-parse FETCH_HEAD)"
else
  bash "${GITHUB_WORKSPACE}/scripts/retry.sh" git fetch --no-tags --depth=1 origin "$base"
fi
git cat-file -e "$base^{commit}"
echo "STATUTE_RECALL_BASE_REF=$base" >> "$GITHUB_ENV"
