#!/usr/bin/env bash
# A proof belongs to this repository and is the target or a same-repository
# release PR squashed onto the exact main base it contains.
# No merge/rebase chains are inferred: an ambiguous relation is refused.
set -euo pipefail
export GIT_NO_REPLACE_OBJECTS=1
# Merge-group receipt: the merge queue fast-forwards main to the merge-group
# commit, so that group's ci-result check run sits on the commit that lands.
# A successful one from a merge_group run of ci.yml can stand in for main/heavy
# plus main/pr-depth (see receipt_covers_release; staging/verified stays
# required on its own). Every GitHub Actions ci-result on the commit must
# bind to its run, and every merge-group ci.yml one must be a completed
# success; anything else refuses.
merge_group_receipt() (
  repo="$1"
  sha="$2"
  receipts=0
  gh_retry_script="${GH_RETRY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/gh-retry.sh}"
  refuse_receipt() { echo "MERGE_GROUP_RECEIPT_REFUSED: $1" >&2; exit 1; }
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$sha" =~ ^[0-9a-f]{40}$ ]] || refuse_receipt 'invalid repository or SHA'
  check_runs=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/commits/$sha/check-runs?check_name=ci-result&filter=all&per_page=100") \
    || refuse_receipt "check runs on $sha are unavailable"
  candidates=$(jq -c '[.[].check_runs[] | select(.name == "ci-result" and .app.slug == "github-actions")]' <<< "$check_runs") \
    || refuse_receipt 'check runs are malformed'
  while IFS= read -r check_run; do
    jq -e --arg sha "$sha" '.head_sha == $sha and (.id | type) == "number" and
      (.check_suite.id | type) == "number" and (.details_url | type) == "string"
    ' <<< "$check_run" >/dev/null || refuse_receipt 'ci-result is not bound to the commit'
    run_link=$(jq -r '.details_url' <<< "$check_run")
    [[ "$run_link" =~ ^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/actions/runs/([1-9][0-9]*)/job/([1-9][0-9]*)$ ]] \
      || refuse_receipt 'ci-result has no run link'
    run_id="${BASH_REMATCH[2]}"
    job_id="${BASH_REMATCH[3]}"
    [[ "${BASH_REMATCH[1]}" == "$repo" ]] || refuse_receipt 'ci-result run link names another repository'
    # The link names an Actions job id, not the check run id; the job binds both.
    job=$(bash "$gh_retry_script" api "repos/$repo/actions/jobs/$job_id") || refuse_receipt "job $job_id is unavailable"
    jq -e --argjson id "$job_id" --argjson run "$run_id" --arg sha "$sha" \
      --arg check_run_url "https://api.github.com/repos/$repo/check-runs/$(jq -r '.id' <<< "$check_run")" '
      .id == $id and .run_id == $run and .head_sha == $sha and .check_run_url == $check_run_url
    ' <<< "$job" >/dev/null || refuse_receipt "job $job_id is not this ci-result in run $run_id"
    run=$(bash "$gh_retry_script" api "repos/$repo/actions/runs/$run_id") || refuse_receipt "run $run_id is unavailable"
    jq -e --argjson id "$run_id" --arg repo "$repo" --arg sha "$sha" --argjson suite "$(jq '.check_suite.id' <<< "$check_run")" '
      .id == $id and .repository.full_name == $repo and .head_sha == $sha and .check_suite_id == $suite
    ' <<< "$run" >/dev/null || refuse_receipt "ci-result does not belong to run $run_id"
    # ci-result jobs of other events or workflows are not receipts.
    if jq -e '.event == "merge_group" and .path == ".github/workflows/ci.yml"' <<< "$run" >/dev/null; then
      jq -e '(.head_branch | type) == "string" and (.head_branch | startswith("gh-readonly-queue/main/")) and
        .status == "completed" and .conclusion == "success"' <<< "$run" >/dev/null \
        || refuse_receipt "merge-group run $run_id is not a completed success from main's queue"
      jq -e '.status == "completed" and .conclusion == "success"' <<< "$check_run" >/dev/null \
        || refuse_receipt "ci-result in merge-group run $run_id is not a completed success"
      receipts=$((receipts + 1))
    fi
  done < <(jq -c '.[]' <<< "$candidates")
  ((receipts > 0)) || refuse_receipt "no ci-result from a merge-group ci.yml run on $sha"
)
if [[ "${1:-}" == --merge-group-receipt ]]; then
  merge_group_receipt "${2:?repository is required}" "${3:?target SHA is required}"
  exit 0
fi
# Whether a receipt may replace the heavy and PR-depth proofs is decided in one
# place: check-release-receipt-coverage.sh, which also requires queue-validated
# history since the previous release. Presence of a receipt alone never drops a
# binding the fallback to main/heavy and main/pr-depth relies on. A caller that
# acts on the decision (the health gate) makes it once and passes it in with
# --receipt-coverage, so verification and the gate can never disagree within
# one run; without the flag the verifier decides itself. A missing or failing
# coverage check counts as no coverage.
receipt_coverage_decision=''
if [[ "${1:-}" == --receipt-coverage ]]; then
  case "${2:-}" in
    covered|uncovered) receipt_coverage_decision="$2" ;;
    *) echo '::error::RELEASE_TREE_PROOF_REFUSED: --receipt-coverage must be covered or uncovered' >&2; exit 1 ;;
  esac
  shift 2
fi
receipt_coverage="$(dirname "${BASH_SOURCE[0]}")/check-release-receipt-coverage.sh"
receipt_covers_release() {
  if [[ -n "$receipt_coverage_decision" ]]; then
    [[ "$receipt_coverage_decision" == covered ]]
    return
  fi
  RELEASE_TREE_PROOF_VERIFIER="${BASH_SOURCE[0]}" bash "$receipt_coverage" "$1" "$2" 2>/dev/null
}
# Discovery returns a candidate SHA or empty on a miss; callers still validate it.
if [[ "${1:-}" == --find-proof ]]; then
  shift
  repo="${1:?repository is required}"
  sha="${2:?target SHA is required}"
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$sha" =~ ^[0-9a-f]{40}$ ]] || exit 1
  gh_retry_script="${GH_RETRY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/gh-retry.sh}"
  suite_contexts='["main/heavy","main/pr-depth"]'
  receipt=''
  has_receipt() {
    if [[ -z "$receipt" ]]; then
      if receipt_covers_release "$repo" "$sha"; then receipt=true; else receipt=false; fi
    fi
    [[ "$receipt" == true ]]
  }
  statuses=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/commits/$sha/statuses?per_page=100")
  green() {
    jq -e --argjson contexts "$1" '
      [.[][]] as $all | all($contexts[]; . as $context |
        ([$all[] | select(.context == $context)][0].state // "missing") == "success")
    ' <<< "$statuses" >/dev/null
  }
  # Prefer complete target evidence; health still rejects any newer red status.
  if green '["staging/verified"]' && { green "$suite_contexts" || has_receipt; }; then
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
  if [[ -z "$candidate" ]]; then exit 0; fi
  read -r proof pull_number <<< "$candidate"
  [[ "$proof" =~ ^[0-9a-f]{40}$ && "$pull_number" =~ ^[1-9][0-9]*$ ]] || exit 1
  proof_statuses=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/commits/$proof/statuses?per_page=100")
  bound() {
    jq -e --argjson contexts "$1" '
      [.[][]] as $all | all($contexts[]; . as $context |
        [$all[] | select(.context == $context)][0] |
        .creator.login == "github-actions[bot]" and .creator.type == "Bot" and
        (.description | type) == "string" and (.description | test("; main=[0-9a-f]{40}$")))
    ' <<< "$proof_statuses" >/dev/null
  }
  # The release head's staging proof is always required; a receipt on the
  # merged commit that covers the release history replaces the head's heavy
  # and PR-depth proofs.
  if ! bound '["staging/verified"]' || ! { bound "$suite_contexts" || has_receipt; }; then
    exit 0
  fi
  files=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/pulls/$pull_number/files?per_page=100")
  if jq -e 'any(.[][]; .filename == "VERSION" and .status == "modified")' <<< "$files" >/dev/null; then
    printf '%s\n' "$proof"
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
  else
    parents=$(git show -s --format=%P "$sha")
    [[ "$parents" =~ ^[0-9a-f]{40}$ ]] || refuse 'target must have one squash parent'
    pulls=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/commits/$sha/pulls?per_page=100")
    jq -e --arg repo "$repo" --arg proof "$proof" --arg sha "$sha" --arg base "$parents" '
      [.[][] | select((.merged_at | type) == "string" and .merged_at != "" and .state == "closed" and .merge_commit_sha == $sha and
        .head.sha == $proof and .head.repo.full_name == $repo and .base.repo.full_name == $repo and
        (.title | startswith("chore: release v")) and .base.ref == "main")] | length == 1
    ' <<< "$pulls" >/dev/null || refuse 'squash PR relation is unverified'
    git merge-base --is-ancestor "$parents" "$proof" || refuse 'proof does not contain squash base'
    # PR base.sha can predate a rebase. The trusted proof jobs record the main
    # tip they actually fetched, and every gate must bind to the squash parent.
    statuses=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/commits/$proof/statuses?per_page=100")
    bound_contexts=(staging/verified)
    # Only a receipt that covers the release history replaces the head's suite
    # proofs; otherwise the gate falls back to them, so they must bind too.
    receipt_covers_release "$repo" "$sha" || bound_contexts+=(main/heavy main/pr-depth)
    for context in "${bound_contexts[@]}"; do
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
  release_version=$(git show "$sha:VERSION" | tr -d '[:space:]')
  jq -e --arg repo "$repo" --arg sha "$sha" --arg base "$main" --arg title "chore: release v$release_version" '
    [.[][] | select(.merged_at == null and .state == "open" and .title == $title and
      .head.sha == $sha and .head.repo.full_name == $repo and .base.repo.full_name == $repo and
      .base.ref == "main")] | length == 1
  ' <<< "$pulls" >/dev/null || refuse 'open release PR relation is unverified'
  # Main moving during a release cut is normal: exit 3 lets a caller skip
  # instead of failing, while every other refusal stays exit 1.
  if ! git merge-base --is-ancestor "$main" "$proof"; then
    echo "RELEASE_TREE_PROOF_STALE: PR head $proof does not contain current main tip $main" >&2
    exit 3
  fi
  candidate_tree_verifier="${RELEASE_CANDIDATE_TREE_VERIFIER:-$(dirname "${BASH_SOURCE[0]}")/verify-release-candidate-tree.mjs}"
  node "$candidate_tree_verifier" "$main" "$proof" || refuse 'release PR changes executable or unbound build input'
  relation=pr-head
fi
if [[ "$sha" != "$proof" && -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf 'reused proof %s (tree %s)\n' "$proof" "$tree" >> "$GITHUB_STEP_SUMMARY"
fi
printf 'proof-sha=%s\ntree=%s\nrelation=%s\nmain-base=%s\n' "$proof" "$tree" "$relation" "$main"
