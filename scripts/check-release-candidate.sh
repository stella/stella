#!/usr/bin/env bash
# Check candidate identity before spending release gates; never create a tag.
set -euo pipefail
[[ $# -eq 1 ]] || { echo "::error::Usage: check-release-candidate.sh <sha>" >&2; exit 2; }
sha="$1"
[[ "$sha" =~ ^[0-9a-fA-F]{40}$ ]] || { echo "::error::Release sha must be a full 40-character commit SHA" >&2; exit 1; }
sha=$(git rev-parse --verify "$sha^{commit}")
version=$(git show "$sha:VERSION" | tr -d '[:space:]')
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "::error::Invalid stable VERSION at release SHA: $version" >&2; exit 1; }
tag="v$version"
if git show-ref --verify --quiet "refs/tags/$tag"; then
  echo "::error::Release tag $tag already exists" >&2
  exit 1
fi
[[ -n "${RELEASE_PROOF_REPOSITORY:-}" && -n "${RELEASE_TREE_PROOF_VERIFIER:-}" ]] || {
  echo "::error::A trusted release PR-head verifier and repository are required" >&2
  exit 1
}
bash "$RELEASE_TREE_PROOF_VERIFIER" --allow-pr-head "$RELEASE_PROOF_REPOSITORY" "$sha" "$sha" >/dev/null
printf 'sha=%s\nvalue=%s\ntag=%s\n' "$sha" "$version" "$tag"
