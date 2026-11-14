#!/usr/bin/env bash
# Resolve the commit a staging deploy builds, promotes and verifies.
# Blank selects the tip of origin/main. An explicit SHA must be a full commit
# SHA on main's first-parent history, or an explicitly authorized release PR
# head verified against main. Anything else is refused.
set -euo pipefail
# Resolved without dirname: callers may run this with only bash and git.
script_dir="${BASH_SOURCE[0]%/*}"
if [[ "$script_dir" == "${BASH_SOURCE[0]}" ]]; then
  script_dir=.
fi
retry_script="$script_dir/retry.sh"

sha=""
release_pr_head="${RELEASE_PR_HEAD:-false}"
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
"$BASH" "$retry_script" git fetch "${fetch_options[@]}" origin +refs/heads/main:refs/remotes/origin/main >&2

main=$(git rev-parse --verify --quiet 'origin/main^{commit}') \
  || { echo "::error::STAGING_SHA_REFUSED: origin/main is not available in this checkout" >&2; exit 1; }

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
