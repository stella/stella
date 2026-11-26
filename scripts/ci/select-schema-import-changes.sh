#!/usr/bin/env bash
set -eo pipefail
if answer=$(timeout --kill-after=10s 120s bun scripts/schema-import-changes.ts); then
  echo "$answer" >> "$GITHUB_OUTPUT"
else
  echo "changed=true" >> "$GITHUB_OUTPUT"
fi
