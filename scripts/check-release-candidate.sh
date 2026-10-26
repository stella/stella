#!/usr/bin/env bash
# Check candidate identity before spending release gates; never create a tag.
set -euo pipefail
[[ ($# -eq 1 && "$1" != --version-commit-for) || ($# -eq 2 && "$1" == --version-commit-for) ]] || { echo "::error::Usage: check-release-candidate.sh <sha|--version-commit|--version-commit-for <version>>" >&2; exit 2; }
version_pattern='^[0-9]+\.[0-9]+\.[0-9]+(-(rc|beta|alpha)\.[0-9]+)?$'
# The newest commit on main's first-parent line that set VERSION to $1. Only
# VERSION edits are inspected; unchanged main commits never gain release
# identity, and a later bump never moves an earlier version's commit.
version_commit_for() {
  local target="$1" commit commit_version parent_version
  while IFS= read -r commit; do
    commit_version=$(git show "$commit:VERSION" 2>/dev/null | tr -d '[:space:]' || true)
    [[ "$commit_version" == "$target" ]] || continue
    parent_version=$(git show "$commit^:VERSION" 2>/dev/null | tr -d '[:space:]' || true)
    if [[ "$parent_version" != "$target" ]]; then
      printf '%s\n' "$commit"
      return 0
    fi
  done < <(git log --first-parent --format=%H origin/main -- VERSION)
  return 1
}
if [[ "$1" == --version-commit-for ]]; then
  [[ "$2" =~ $version_pattern ]] || { echo "::error::Release version must look like 1.2.3 or 1.2.3-rc.1, got: $2" >&2; exit 1; }
  version_commit_for "$2" || { echo "::error::No commit on main's first-parent history sets VERSION to $2" >&2; exit 1; }
  exit 0
fi
main_version=$(git show origin/main:VERSION | tr -d '[:space:]')
version_commit=$(version_commit_for "$main_version") || { echo "::error::Cannot resolve pending VERSION commit" >&2; exit 1; }
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
if [[ ! "$version" =~ $version_pattern ]]; then
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
