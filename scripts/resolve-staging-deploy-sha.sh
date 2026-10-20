#!/usr/bin/env bash
# Resolve the commit a staging deploy builds, promotes and verifies.
# Blank selects the tip of origin/main. An explicit SHA must be a full commit
# SHA on main's first-parent history, or an explicitly authorized release PR
# head verified against main, or a release merge-group entry bound to main.
# Anything else is refused.
set -euo pipefail

sha=""
release_pr_head="${RELEASE_PR_HEAD:-false}"
expected_base="${EXPECTED_BASE:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha) sha="${2-}"; shift 2 ;;
    *) echo "::error::Unknown argument: $1" >&2; exit 2 ;;
  esac
done

fetch_options=(--no-tags)
if [[ "$(git rev-parse --is-shallow-repository)" == true ]]; then
  fetch_options+=(--unshallow)
fi
git fetch "${fetch_options[@]}" origin +refs/heads/main:refs/remotes/origin/main

main=$(git rev-parse --verify --quiet 'origin/main^{commit}') \
  || { echo "::error::STAGING_SHA_REFUSED: origin/main is not available in this checkout" >&2; exit 1; }

if [[ -n "$expected_base" ]]; then
  [[ "$release_pr_head" == true && "$sha" =~ ^[0-9a-fA-F]{40}$ && "$expected_base" =~ ^[0-9a-fA-F]{40}$ ]] \
    || { echo "::error::STAGING_SHA_REFUSED: a release merge group requires full sha and expected_base" >&2; exit 1; }
  [[ "$expected_base" == "$main" ]] \
    || { echo "::error::STAGING_SHA_REFUSED: group no longer the head group" >&2; exit 1; }
  # Resolve only server-advertised queue refs, never a caller-supplied branch.
  queue_refs=$(git ls-remote --heads origin 'refs/heads/gh-readonly-queue/main/pr-*-*')
  accepted=false
  while read -r queue_sha queue_ref; do
    [[ "$queue_sha" == "$sha" && "$queue_ref" =~ ^refs/heads/gh-readonly-queue/main/pr-([0-9]+)-[0-9a-f]+$ ]] || continue
    number="${BASH_REMATCH[1]}"
    release=$(bash "$(dirname "$0")/release-pull-requests.sh" --repo "${GITHUB_REPOSITORY:?repository is required}" --number "$number")
    [[ $'\n'"$release"$'\n' == *$'\ncurrent_is_release=true\n'* ]] || continue
    git fetch --no-tags origin "$queue_ref"
    [[ "$(git rev-parse FETCH_HEAD)" == "$sha" ]] || continue
    history=$(git rev-list --first-parent "$sha")
    [[ $'\n'"$history"$'\n' == *$'\n'"$expected_base"$'\n'* && "$sha" != "$expected_base" ]] || continue
    accepted=true
    break
  done <<< "$queue_refs"
  [[ "$accepted" == true ]] \
    || { echo "::error::STAGING_SHA_REFUSED: sha is not a release entry merge group reaching expected_base" >&2; exit 1; }
  printf 'sha=%s\ntip=false\nmain-sha=%s\n' "$sha" "$main"
  exit 0
fi

if [[ -z "$sha" ]]; then
  printf 'sha=%s\ntip=true\nmain-sha=%s\n' "$main" "$main"
  exit 0
fi

if [[ ! "$sha" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "::error::STAGING_SHA_REFUSED: sha must be a full 40-character commit SHA" >&2
  exit 1
fi
if [[ "$release_pr_head" == true ]]; then
  bash "${RELEASE_TREE_PROOF_VERIFIER:?trusted verifier is required}" --allow-pr-head "${GITHUB_REPOSITORY:?repository is required}" "$sha" "$sha" >/dev/null
fi
resolved=$(git rev-parse --verify --quiet "$sha^{commit}") \
  || { echo "::error::STAGING_SHA_REFUSED: $sha is not a commit in this repository" >&2; exit 1; }
history=$(git rev-list --first-parent "$main")
if [[ "$release_pr_head" != true && $'\n'"$history"$'\n' != *$'\n'"$resolved"$'\n'* ]]; then
  echo "::error::STAGING_SHA_REFUSED: $resolved is not on the first-parent history of origin/main ($main)" >&2
  exit 1
fi
tip=false
[[ "$resolved" != "$main" ]] || tip=true
printf 'sha=%s\ntip=%s\nmain-sha=%s\n' "$resolved" "$tip" "$main"
