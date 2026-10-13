#!/usr/bin/env bash
# Resolve a release candidate without changing the checkout or creating a tag.
set -euo pipefail

gh_retry_script="${GH_RETRY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/gh-retry.sh}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo=""
sha=""
proof=""
tree_proof_verifier="${RELEASE_TREE_PROOF_VERIFIER:-$script_dir/verify-release-tree-proof.sh}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) repo="${2:?--repo needs a value}"; shift 2 ;;
    --sha) sha="${2-}"; shift 2 ;;
    --proof-sha) proof="${2-}"; shift 2 ;;
    *) echo "::error::Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$repo" ]] || { echo "::error::--repo is required" >&2; exit 2; }

# All gates must succeed on one verified proof commit.
required_contexts='["staging/verified","main/heavy","main/pr-depth"]'

release_states() {
  # Statuses arrive newest first. A later failure invalidates an earlier success.
  bash "$gh_retry_script" api --paginate --slurp "repos/$repo/commits/$1/statuses?per_page=100" \
    | jq -r --argjson contexts "$required_contexts" '
        [.[][]] as $all
        | $contexts[]
        | . as $context
        | "\($context) = \(([$all[] | select(.context == $context)][0].state) // "missing")"'
}

all_success() {
  ! grep -qv ' = success$' <<< "$1"
}

if [[ -z "$sha" ]]; then
  candidates=$(git rev-list --first-parent origin/main)
  while IFS= read -r candidate; do
    selected_proof=$(bash "$tree_proof_verifier" --find-proof "$repo" "$candidate")
    states=$(release_states "$selected_proof")
    if all_success "$states"; then
      sha="$candidate"
      proof="$selected_proof"
      break
    fi
  done <<< "$candidates"
  [[ -n "$sha" ]] || { echo "::error::No commit on main carries success on staging/verified, main/heavy and main/pr-depth" >&2; exit 1; }
fi

candidate=$(bash "$script_dir/check-release-candidate.sh" "$sha")
while IFS='=' read -r key value; do
  case "$key" in sha) sha="$value" ;; esac
done <<< "$candidate"
if [[ -z "$proof" ]]; then proof=$(bash "$tree_proof_verifier" --find-proof "$repo" "$sha"); fi
bash "$tree_proof_verifier" "$repo" "$sha" "$proof" >/dev/null
states=$(release_states "$proof")
if ! all_success "$states"; then
  missing=$(grep -v ' = success$' <<< "$states" | paste -sd ',' - | sed 's/,/, /g')
  echo "::error::RELEASE_STATUS_NOT_GREEN: release SHA $sha needs success on staging/verified, main/heavy and main/pr-depth; it carries $missing" >&2
  exit 1
fi
bash "$script_dir/check-release-main-health.sh" "$repo" "$sha" "$proof"
changesets=$(git ls-tree -r --name-only "$sha" -- '.changeset/*.md' '.changeset')
if [[ -n "$(printf '%s\n' "$changesets" | sed -n '/^\.changeset\/[^/]*\.md$/ { /\/README\.md$/d; p; }')" ]]; then
  echo "::warning::Release SHA carries unconsumed changesets; their notes will appear in a later release." >&2
fi
printf '%s\n' "$candidate"
if [[ "$proof" != "$sha" ]]; then printf 'proof-sha=%s\n' "$proof"; fi
