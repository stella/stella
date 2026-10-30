#!/usr/bin/env bash
# Materialise what the package API check reads from its Git base, so the check
# itself reads files only and runs under the offline network preload:
#   <directory>/tree/                the merge base's packages/*/api-report.json
#                                    and .changeset/*.md files;
#   <directory>/changed-changesets   changesets added or modified since the
#                                    merge base, one path per line.
# Usage: bash scripts/package-api-base.sh <base-ref> <directory>
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: bash scripts/package-api-base.sh <base-ref> <directory>" >&2
  exit 2
fi
base_ref="$1"
directory="$2"

merge_base="$(git merge-base "$base_ref" HEAD)"
mkdir -p "$directory/tree"
git ls-tree -r --name-only "$merge_base" -- packages .changeset |
  while IFS= read -r file; do
    case "$file" in
      packages/*/api-report.json | .changeset/*.md) ;;
      *) continue ;;
    esac
    mkdir -p "$directory/tree/$(dirname "$file")"
    git show "$merge_base:$file" >"$directory/tree/$file"
  done
git diff --name-only --diff-filter=AM "$merge_base" -- .changeset \
  >"$directory/changed-changesets"
