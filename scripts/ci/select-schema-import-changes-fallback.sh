#!/usr/bin/env bash
set -eo pipefail
status=0
grep -zEq '^(apps/api|packages)/.*\.tsx?$' "$CHANGED_PATHS" || status=$?
if [[ "$status" == 1 ]]; then
  echo "changed=false" >> "$GITHUB_OUTPUT"
else
  echo "changed=true" >> "$GITHUB_OUTPUT"
fi
