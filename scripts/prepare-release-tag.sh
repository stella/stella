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

# All status gates must succeed on one verified proof commit. A merge-group
# ci-result receipt on the release commit itself stands in for main/heavy and
# main/pr-depth; staging/verified is always required.
required_contexts='["staging/verified","main/heavy","main/pr-depth"]'
gates_message='staging/verified plus either main/heavy and main/pr-depth or a merge-group ci-result receipt'

release_states() {
  local proof_sha="$1" target_sha="$2" states
  # Statuses arrive newest first. A later failure invalidates an earlier success.
  states=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/commits/$proof_sha/statuses?per_page=100" \
    | jq -r --argjson contexts "$required_contexts" '
        [.[][]] as $all
        | $contexts[]
        | . as $context
        | "\($context) = \(([$all[] | select(.context == $context)][0].state) // "missing")"') || return 1
  if all_success "$states"; then
    printf '%s\n' "$states"
  elif grep -qx 'staging/verified = success' <<< "$states" \
    && bash "$tree_proof_verifier" --merge-group-receipt "$repo" "$target_sha" 2>/dev/null; then
    printf '%s\n' 'staging/verified = success' 'merge-group receipt = success'
  else
    printf '%s\n' "$states" 'merge-group receipt = missing'
  fi
}

all_success() {
  ! grep -qv ' = success$' <<< "$1"
}

if [[ -z "$sha" ]]; then
  candidates=$(git rev-list --first-parent origin/main)
  while IFS= read -r candidate; do
    selected_proof=$(bash "$tree_proof_verifier" --find-proof "$repo" "$candidate")
    selected_proof="${selected_proof:-$candidate}"
    states=$(release_states "$selected_proof" "$candidate")
    if all_success "$states"; then
      sha="$candidate"
      proof="$selected_proof"
      break
    fi
  done <<< "$candidates"
  [[ -n "$sha" ]] || { echo "::error::No commit on main carries $gates_message" >&2; exit 1; }
fi

candidate=$(bash "$script_dir/check-release-candidate.sh" "$sha")
while IFS='=' read -r key value; do
  case "$key" in sha) sha="$value" ;; esac
done <<< "$candidate"
if [[ -z "$proof" ]]; then
  proof=$(bash "$tree_proof_verifier" --find-proof "$repo" "$sha")
  proof="${proof:-$sha}"
fi
bash "$tree_proof_verifier" "$repo" "$sha" "$proof" >/dev/null
states=$(release_states "$proof" "$sha")
if ! all_success "$states"; then
  missing=$(grep -v ' = success$' <<< "$states" | paste -sd ',' - | sed 's/,/, /g')
  echo "::error::RELEASE_STATUS_NOT_GREEN: release SHA $sha needs $gates_message; it carries $missing" >&2
  exit 1
fi
bash "$script_dir/check-release-main-health.sh" "$repo" "$sha" "$proof"
changesets=$(git ls-tree -r --name-only "$sha" -- '.changeset/*.md' '.changeset')
if [[ -n "$(printf '%s\n' "$changesets" | sed -n '/^\.changeset\/[^/]*\.md$/ { /\/README\.md$/d; p; }')" ]]; then
  echo "::warning::Release SHA carries unconsumed changesets; their notes will appear in a later release." >&2
fi
printf '%s\n' "$candidate"
if [[ "$proof" != "$sha" ]]; then printf 'proof-sha=%s\n' "$proof"; fi
