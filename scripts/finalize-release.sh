#!/usr/bin/env bash
# Finalization writes only pointers after exact-commit proof succeeds.
set -euo pipefail
repo="${1:?repository is required}"
sha="${2:?candidate SHA is required}"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gh_retry_script="${GH_RETRY_SCRIPT:-$script_dir/gh-retry.sh}"
version=$(git show "$sha:VERSION" | tr -d '[:space:]')
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 2
final="v$version"
rc=""
while IFS= read -r tag; do
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[1-9][0-9]*$ ]] || continue
  if [[ "$(git rev-parse "$tag^{commit}")" == "$sha" ]]; then rc="$tag"; break; fi
done < <(git tag --list "v$version-rc.*" --sort=-v:refname)
[[ -n "$rc" ]] || { echo "No RC receipt on $sha" >&2; exit 0; }
# A final tag is written once; release-finalize-eligibility.sh refuses runs
# after it exists.
if git show-ref --verify --quiet "refs/tags/$final"; then
  echo "Final tag $final already exists" >&2
  exit 1
fi
GH_TOKEN="${RELEASE_HEALTH_TOKEN:-${GH_TOKEN:-}}" bash "$script_dir/check-release-main-health.sh" "$repo" "$sha" "$sha"
rc_sha=$(git rev-parse "$rc^{commit}")
[[ "$rc_sha" == "$sha" ]] || exit 1
git tag -a "$final" "$rc_sha" -m "$final"
git push "https://x-access-token:${GH_TOKEN:?}@github.com/$repo.git" "refs/tags/$final"
is_draft=$(GH_TOKEN="${RELEASE_HEALTH_TOKEN:-${GH_TOKEN:-}}" bash "$gh_retry_script" release view "$rc" --repo "$repo" --json isDraft --jq '.isDraft')
case "$is_draft" in
  true) bash "$gh_retry_script" release edit "$rc" --repo "$repo" --draft=false --prerelease --latest=false ;;
  false) ;;
  *) echo "Could not resolve prerelease publication for $rc" >&2; exit 1 ;;
esac
