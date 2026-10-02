#!/usr/bin/env bash
# Resolve a release candidate without changing the checkout or creating a tag.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

repo=""
sha=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) repo="${2:?--repo needs a value}"; shift 2 ;;
    --sha) sha="${2-}"; shift 2 ;;
    *) echo "::error::Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$repo" ]] || { echo "::error::--repo is required" >&2; exit 2; }

verified_state() {
  # Statuses arrive newest first. A later failure invalidates an earlier success.
  gh api --paginate --slurp "repos/$repo/commits/$1/statuses?per_page=100" \
    | jq -r '[.[][] | select(.context == "staging/verified")][0].state // "missing"'
}

if [[ -z "$sha" ]]; then
  candidates=$(git rev-list origin/main)
  while IFS= read -r candidate; do
    state=$(verified_state "$candidate")
    if [[ "$state" == "success" ]]; then
      sha="$candidate"
      break
    fi
  done <<< "$candidates"
  [[ -n "$sha" ]] || { echo "::error::No commit on main carries staging/verified = success" >&2; exit 1; }
fi

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
state=$(verified_state "$sha")
if [[ "$state" != "success" ]]; then
  echo "::error::Release SHA $sha carries staging/verified = $state; success is required" >&2
  exit 1
fi
bun "$script_dir/main-health.ts" --release-guard "$sha" --repo "$repo"
changesets=$(git ls-tree -r --name-only "$sha" -- '.changeset/*.md' '.changeset')
if [[ -n "$(printf '%s\n' "$changesets" | sed -n '/^\.changeset\/[^/]*\.md$/ { /\/README\.md$/d; p; }')" ]]; then
  echo "::warning::Release SHA carries unconsumed changesets; their notes will appear in a later release." >&2
fi
printf 'sha=%s\nvalue=%s\ntag=%s\n' "$sha" "$version" "$tag"
