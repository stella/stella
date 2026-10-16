#!/usr/bin/env bash
set -euo pipefail

base_ref="${CHECK_BASE_REF:-origin/main}"

if base="$(git merge-base HEAD "$base_ref" 2>/dev/null)"; then
  printf '%s\n' "$base"
  exit 0
fi

# GitHub's checkout leaves HEAD as a shallow boundary. Fetch the requested
# event base, then only the ancestry from the checked-out commit down to it.
if [[ "$(git rev-parse --is-shallow-repository)" == true ]]; then
  head="$(git rev-parse HEAD)"
  git fetch --no-tags --depth=1 origin "$base_ref"
  depth=1
  max_depth=2048
  while [[ "$(git rev-parse --is-shallow-repository)" == true && "$depth" -lt "$max_depth" ]]; do
    before="$(git rev-list --count HEAD "$base_ref")"
    git fetch --no-tags --deepen=32 origin "$head" "$base_ref"
    if git merge-base HEAD "$base_ref" >/dev/null 2>&1; then
      break
    fi
    after="$(git rev-list --count HEAD "$base_ref")"
    if [[ "$after" == "$before" ]]; then
      break
    fi
    depth=$((depth + 32))
  done
fi

if ! base="$(git merge-base HEAD "$base_ref" 2>/dev/null)"; then
  echo "ExternalContractBaselineUnavailable: cannot resolve merge-base with $base_ref" >&2
  exit 1
fi
printf '%s\n' "$base"
