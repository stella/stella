#!/usr/bin/env bash
# Check candidate identity before spending release gates; never create a tag.
set -euo pipefail
[[ $# -eq 1 ]] || { echo "::error::Usage: check-release-candidate.sh <sha>" >&2; exit 2; }
sha="$1"

if [[ ! "$sha" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "::error::Release sha must be a full 40-character commit SHA" >&2
  exit 1
fi
sha=$(git rev-parse --verify "$sha^{commit}")
if ! git merge-base --is-ancestor "$sha" origin/main; then
  echo "::error::Release SHA $sha is not an ancestor of origin/main" >&2
  exit 1
fi
version=$(git show "$sha:VERSION" | tr -d '[:space:]')
main_version=$(git show origin/main:VERSION | tr -d '[:space:]')
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(rc|beta|alpha)\.[0-9]+)?$ ]]; then
  echo "::error::Invalid VERSION at release SHA: $version" >&2
  exit 1
fi
if [[ "$version" != "$main_version" ]]; then
  echo "::error::VERSION at release SHA ($version) does not match pending VERSION on main ($main_version)" >&2
  exit 1
fi
tag="v$version"
if git show-ref --verify --quiet "refs/tags/$tag"; then
  echo "::error::Release tag $tag already exists" >&2
  exit 1
fi
printf 'sha=%s\nvalue=%s\ntag=%s\n' "$sha" "$version" "$tag"
