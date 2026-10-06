#!/usr/bin/env bash
# Resolve the commit a staging deploy builds, promotes and verifies.
# Blank selects the tip of origin/main. An explicit SHA must be a full commit
# SHA that is an ancestor of (or equal to) origin/main, so a release can pin
# its candidate while main keeps moving. Anything else is refused.
set -euo pipefail

sha=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha) sha="${2-}"; shift 2 ;;
    *) echo "::error::Unknown argument: $1" >&2; exit 2 ;;
  esac
done

main=$(git rev-parse --verify --quiet 'origin/main^{commit}') \
  || { echo "::error::STAGING_SHA_REFUSED: origin/main is not available in this checkout" >&2; exit 1; }

if [[ -z "$sha" ]]; then
  printf 'sha=%s\ntip=true\n' "$main"
  exit 0
fi

if [[ ! "$sha" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "::error::STAGING_SHA_REFUSED: sha must be a full 40-character commit SHA" >&2
  exit 1
fi
resolved=$(git rev-parse --verify --quiet "$sha^{commit}") \
  || { echo "::error::STAGING_SHA_REFUSED: $sha is not a commit in this repository" >&2; exit 1; }
if ! git merge-base --is-ancestor "$resolved" "$main"; then
  echo "::error::STAGING_SHA_REFUSED: $resolved is not an ancestor of origin/main ($main)" >&2
  exit 1
fi
tip=false
[[ "$resolved" != "$main" ]] || tip=true
printf 'sha=%s\ntip=%s\n' "$resolved" "$tip"
