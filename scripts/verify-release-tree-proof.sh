#!/usr/bin/env bash
# A proof belongs to this repository and either main's unchanged first-parent
# chain or a same-repository PR squashed onto the exact main base it contains.
# No merge/rebase chains are inferred: an ambiguous relation is refused.
set -euo pipefail
export GIT_NO_REPLACE_OBJECTS=1
# Discovery returns only a candidate; callers still validate its status provenance.
if [[ "${1:-}" == --find-proof ]]; then
  shift
  repo="${1:?repository is required}"
  sha="${2:?target SHA is required}"
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$sha" =~ ^[0-9a-f]{40}$ ]] || exit 1
  gh_retry_script="${GH_RETRY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/gh-retry.sh}"
  contexts='["staging/verified","main/heavy","main/pr-depth"]'
  statuses=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/commits/$sha/statuses?per_page=100")
  # Prefer complete target evidence; health still rejects any newer red status.
  if jq -e --argjson contexts "$contexts" '
    [.[][]] as $all | all($contexts[]; . as $context |
      ([$all[] | select(.context == $context)][0].state // "missing") == "success")
  ' <<< "$statuses" >/dev/null; then
    printf '%s\n' "$sha"
    exit 0
  fi
  pulls=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/commits/$sha/pulls?per_page=100")
  candidate=$(jq -r --arg repo "$repo" --arg sha "$sha" '
    [.[][] | select((.merged_at | type) == "string" and .merged_at != "" and .state == "closed" and
      (.title | startswith("chore: release v")) and .merge_commit_sha == $sha and .head.repo.full_name == $repo and
      .base.repo.full_name == $repo and .base.ref == "main")] |
    if length == 0 then empty elif length == 1 then "\(.[0].head.sha) \(.[0].number)"
    else error("ambiguous release proof") end
  ' <<< "$pulls")
  if [[ -z "$candidate" ]]; then printf '%s\n' "$sha"; exit 0; fi
  read -r proof pull_number <<< "$candidate"
  [[ "$proof" =~ ^[0-9a-f]{40}$ && "$pull_number" =~ ^[1-9][0-9]*$ ]] || exit 1
  proof_statuses=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/commits/$proof/statuses?per_page=100")
  if ! jq -e --argjson contexts "$contexts" '
    [.[][]] as $all | all($contexts[]; . as $context |
      [$all[] | select(.context == $context)][0] |
      .creator.login == "github-actions[bot]" and .creator.type == "Bot" and
      (.description | type) == "string" and (.description | test("; main=[0-9a-f]{40}$")))
  ' <<< "$proof_statuses" >/dev/null; then
    printf '%s\n' "$sha"
    exit 0
  fi
  files=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/pulls/$pull_number/files?per_page=100")
  if jq -e 'any(.[][]; .filename == "VERSION" and .status == "modified")' <<< "$files" >/dev/null; then
    printf '%s\n' "$proof"
  else
    printf '%s\n' "$sha"
  fi
  exit 0
fi
allow_pr_head=false
if [[ "${1:-}" == --allow-pr-head ]]; then allow_pr_head=true; shift; fi
repo="${1:?repository is required}"
sha="${2:?target SHA is required}"
proof="${3:?proof SHA is required}"
gh_retry_script="${GH_RETRY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/gh-retry.sh}"
refuse() { echo "::error::RELEASE_TREE_PROOF_REFUSED: $1" >&2; exit 1; }
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$sha" =~ ^[0-9a-f]{40}$ && "$proof" =~ ^[0-9a-f]{40}$ ]] || refuse 'invalid repository or SHA'
# Local object presence alone is insufficient: fork objects can share a clone.
commits=("$sha")
[[ "$proof" == "$sha" ]] || commits+=("$proof")
for commit in "${commits[@]}"; do
  metadata=$(bash "$gh_retry_script" api "repos/$repo/commits/$commit")
  jq -e --arg sha "$commit" '.sha == $sha' <<< "$metadata" >/dev/null || refuse 'commit is unavailable in repository'
  if ! git cat-file -e "$commit^{commit}"; then
    git fetch --no-tags "https://github.com/$repo.git" "$commit"
  fi
  tree=$(git rev-parse --verify "$commit^{tree}")
  jq -e --arg tree "$tree" '.commit.tree.sha == $tree' <<< "$metadata" >/dev/null || refuse 'repository tree does not match local commit'
done
tree=$(git rev-parse --verify "$sha^{tree}")
[[ "$tree" == "$(git rev-parse --verify "$proof^{tree}")" ]] || refuse 'trees differ'
main=$(git rev-parse --verify 'origin/main^{commit}')
history=$(git rev-list --first-parent "$main")
if [[ $'\n'"$history"$'\n' == *$'\n'"$sha"$'\n'* ]]; then
  comparison=$(bash "$gh_retry_script" api "repos/$repo/compare/$sha...main")
  jq -e --arg sha "$sha" '(.status == "ahead" or .status == "identical") and .merge_base_commit.sha == $sha' <<< "$comparison" >/dev/null \
    || refuse 'RELEASE_HEAVY_NOT_GREEN: target is not on repository main'
  if [[ "$proof" == "$sha" ]]; then
    relation=main
  elif [[ $'\n'"$history"$'\n' == *$'\n'"$proof"$'\n'* ]] && git merge-base --is-ancestor "$proof" "$sha"; then
    # The supported ancestor chain consists solely of unchanged trees.
    for commit in $(git rev-list --first-parent "$proof..$sha"); do
      [[ "$(git rev-parse "$commit^{tree}")" == "$tree" ]] || refuse 'ancestor chain changes the tree'
    done
    relation=ancestor
  else
    parents=$(git show -s --format=%P "$sha")
    [[ "$parents" =~ ^[0-9a-f]{40}$ ]] || refuse 'target must have one squash parent'
    pulls=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/commits/$sha/pulls?per_page=100")
    jq -e --arg repo "$repo" --arg proof "$proof" --arg sha "$sha" --arg base "$parents" '
      [.[][] | select((.merged_at | type) == "string" and .merged_at != "" and .state == "closed" and .merge_commit_sha == $sha and
        .head.sha == $proof and .head.repo.full_name == $repo and .base.repo.full_name == $repo and
        .base.ref == "main")] | length == 1
    ' <<< "$pulls" >/dev/null || refuse 'squash PR relation is unverified'
    git merge-base --is-ancestor "$parents" "$proof" || refuse 'proof does not contain squash base'
    # PR base.sha can predate a rebase. The trusted proof jobs record the main
    # tip they actually fetched, and every gate must bind to the squash parent.
    statuses=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/commits/$proof/statuses?per_page=100")
    for context in staging/verified main/heavy main/pr-depth; do
      jq -e --arg context "$context" --arg suffix "; main=$parents" '
        [.[][] | select(.context == $context)][0] |
        .creator.login == "github-actions[bot]" and .creator.type == "Bot" and
        (.description | type) == "string" and (.description | endswith($suffix))
      ' <<< "$statuses" >/dev/null || refuse "$context tested main base is unverified"
    done
    relation=squash
  fi
else
  [[ "$allow_pr_head" == true && "$sha" == "$proof" ]] || refuse 'target is not on main'
  pulls=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/commits/$sha/pulls?per_page=100")
  jq -e --arg repo "$repo" --arg sha "$sha" --arg base "$main" '
    [.[][] | select(.merged_at == null and .state == "open" and (.title | startswith("chore: release v")) and
      .head.sha == $sha and .head.repo.full_name == $repo and .base.repo.full_name == $repo and
      .base.ref == "main")] | length == 1
  ' <<< "$pulls" >/dev/null || refuse 'open release PR relation is unverified'
  git merge-base --is-ancestor "$main" "$proof" || refuse 'PR head does not contain current main tip'
  relation=pr-head
fi
if [[ "$sha" != "$proof" && -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf 'reused proof %s (tree %s)\n' "$proof" "$tree" >> "$GITHUB_STEP_SUMMARY"
fi
printf 'proof-sha=%s\ntree=%s\nrelation=%s\nmain-base=%s\n' "$proof" "$tree" "$relation" "$main"
