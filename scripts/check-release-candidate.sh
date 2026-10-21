#!/usr/bin/env bash
# Check candidate identity before spending release gates; never create a tag.
set -euo pipefail
[[ $# -eq 1 ]] || { echo "::error::Usage: check-release-candidate.sh <sha|--version-commit>" >&2; exit 2; }
main_version=$(git show origin/main:VERSION | tr -d '[:space:]')
version_commit=""
# Inspect only VERSION edits; unchanged main commits never gain release identity.
while IFS= read -r commit; do
  parent_version=$(git show "$commit^:VERSION" 2>/dev/null | tr -d '[:space:]' || true)
  if [[ "$parent_version" != "$main_version" ]]; then
    version_commit="$commit"
    break
  fi
done < <(git log --first-parent --format=%H origin/main -- VERSION)
[[ -n "$version_commit" ]] || { echo "::error::Cannot resolve pending VERSION commit" >&2; exit 1; }
if [[ "$1" == --version-commit ]]; then
  printf '%s\n' "$version_commit"
  exit 0
fi
sha="$1"

if [[ ! "$sha" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "::error::Release sha must be a full 40-character commit SHA" >&2
  exit 1
fi
sha=$(git rev-parse --verify "$sha^{commit}")
relation=main
if ! git merge-base --is-ancestor "$sha" origin/main; then
  if [[ -z "${RELEASE_PROOF_REPOSITORY:-}" ]]; then
    echo "::error::Release SHA $sha is not an ancestor of origin/main; version commit is $version_commit" >&2
    exit 1
  fi
  bash "${RELEASE_TREE_PROOF_VERIFIER:?trusted verifier is required}" --allow-pr-head "$RELEASE_PROOF_REPOSITORY" "$sha" "$sha" >/dev/null
  relation=pr-head
fi
version=$(git show "$sha:VERSION" | tr -d '[:space:]')
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(rc|beta|alpha)\.[0-9]+)?$ ]]; then
  echo "::error::Invalid VERSION at release SHA: $version" >&2
  exit 1
fi
if [[ "$relation" == main ]] && [[ "$version" != "$main_version" ]]; then
  echo "::error::VERSION at release SHA ($version) does not match pending VERSION on main ($main_version); version commit is $version_commit" >&2
  exit 1
fi
if [[ "$relation" == main && "$sha" != "$version_commit" ]]; then
  echo "::error::Release SHA $sha must be the pending VERSION $main_version version commit $version_commit" >&2
  exit 1
fi
tag="v$version"
if git show-ref --verify --quiet "refs/tags/$tag"; then
  echo "::error::Release tag $tag already exists" >&2
  exit 1
fi
printf 'sha=%s\nvalue=%s\ntag=%s\n' "$sha" "$version" "$tag"
