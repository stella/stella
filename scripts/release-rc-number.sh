#!/usr/bin/env bash
# Local tag receipts reserve RC numbers, including failed candidates.
set -euo pipefail
version="${1:?stable version is required}"
sha="${2:?candidate SHA is required}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
if git show-ref --verify --quiet "refs/tags/v$version"; then
  echo "::error::Final release v$version already exists" >&2
  exit 1
fi
highest=0
existing=""
while IFS= read -r tag; do
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-rc\.([1-9][0-9]*)$ ]] || continue
  number="${BASH_REMATCH[1]}"
  ((number > highest)) && highest="$number"
  if [[ "$(git rev-parse "$tag^{commit}")" == "$sha" ]]; then existing="$tag"; fi
done < <(git tag --list "v$version-rc.*" --sort=v:refname)
if [[ -n "$existing" ]]; then
  printf 'tag=%s\nexisting=true\n' "$existing"
else
  printf 'tag=v%s-rc.%s\nexisting=false\n' "$version" "$((highest + 1))"
fi
