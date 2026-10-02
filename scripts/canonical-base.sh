#!/usr/bin/env bash
#
# Prints the ref that local checks compare a branch against: `main` on the
# remote that points at the canonical repository. In a fork clone `origin` is
# the fork, whose `main` may be far behind; comparing against it would widen
# or narrow the affected set silently.
#
# Usage: canonical_base_ref (after `source scripts/canonical-base.sh`)

CANONICAL_REPOSITORY="stella/stella"

is_canonical_url() {
  local url="${1%.git}"
  [[ "$url" == "https://github.com/$CANONICAL_REPOSITORY" ||
    "$url" == "git@github.com:$CANONICAL_REPOSITORY" ||
    "$url" == "ssh://git@github.com/$CANONICAL_REPOSITORY" ]]
}

canonical_base_ref() {
  local origin_url remote
  origin_url="$(git remote get-url origin 2>/dev/null || true)"
  if is_canonical_url "$origin_url"; then
    echo "origin/main"
    return 0
  fi
  while read -r remote; do
    if is_canonical_url "$(git remote get-url "$remote")"; then
      echo "$remote/main"
      return 0
    fi
  done < <(git remote)
  echo "No remote points at github.com/$CANONICAL_REPOSITORY; add one with" >&2
  echo "  git remote add upstream https://github.com/$CANONICAL_REPOSITORY.git && git fetch upstream" >&2
  echo "or pass --base <ref>." >&2
  return 1
}
