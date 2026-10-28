#!/usr/bin/env bash
# Read-only release gate, run again immediately before the tag push: the commit
# needs staging/verified plus either a merge-group ci-result receipt on the
# commit itself whose queue history since the previous release tag is fully
# validated (check-release-receipt-coverage.sh), or trusted main/heavy and
# main/pr-depth success; sparse or skipped heavy runs provide no green evidence.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gh_retry_script="${GH_RETRY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/gh-retry.sh}"
repo="${1:?repository is required}"
sha="${2:?commit SHA is required}"
tree_proof_verifier="${RELEASE_TREE_PROOF_VERIFIER:-$(dirname "${BASH_SOURCE[0]}")/verify-release-tree-proof.sh}"
proof="${3:-}"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo '::error::RELEASE_HEAVY_NOT_GREEN: invalid repository or SHA' >&2; exit 1;
}
refuse() { echo "::error::$1" >&2; exit 1; }
# One receipt decision per run, made before anything relies on it: the
# receipt is read on the release commit itself, never on a reused proof, and
# counts only when no commit since the previous release bypassed the merge
# queue. The verifier receives the same decision, so the suite bindings it
# skips are exactly the statuses this gate does not require. Output stays on
# stderr: callers forward stdout to step outputs.
required_contexts='["staging/verified","main/heavy","main/pr-depth"]'
receipt=false
coverage=uncovered
rc_tags=$(git tag --points-at "$sha" --list 'v*-rc.*')
if [[ -z "$rc_tags" ]] && bash "$script_dir/check-release-receipt-coverage.sh" "$repo" "$sha"; then
  receipt=true
  coverage=covered
  required_contexts='["staging/verified"]'
fi
if [[ -z "$proof" ]]; then
  proof=$(bash "$tree_proof_verifier" --receipt-coverage "$coverage" --find-proof "$repo" "$sha")
  proof="${proof:-$sha}"
fi
bash "$tree_proof_verifier" --receipt-coverage "$coverage" "$repo" "$sha" "$proof" >/dev/null
if [[ "$proof" != "$sha" ]]; then
  target_statuses=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/commits/$sha/statuses?per_page=100")
  jq -e --argjson contexts "$required_contexts" '
    [.[][]] as $all | all($contexts[];
      . as $context | ([$all[] | select(.context == $context)][0].state // "missing") as $state |
      $state == "missing" or $state == "success")
  ' <<< "$target_statuses" >/dev/null || refuse 'RELEASE_STATUS_NOT_GREEN: target has a newer non-green status'
fi
statuses=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/commits/$proof/statuses?per_page=100")
# Statuses arrive newest first, so a later failure replaces an earlier success.
verified=$(jq -r '[.[][] | select(.context == "staging/verified")][0].state // "missing"' <<< "$statuses")
[[ "$verified" == "success" ]] \
  || refuse "RELEASE_STATUS_NOT_GREEN: staging/verified = $verified on $proof; success is required"
validate_workflow_status() {
  local context="$1" workflow="$2" title="$3" code="$4" status url run_id run
  status=$(jq -ce --arg context "$context" '[.[][] | select(.context == $context)][0] // error("missing status")' <<< "$statuses") \
    || refuse "$code: $context is missing on $proof"
  jq -e '.state == "success" and .creator.login == "github-actions[bot]" and .creator.type == "Bot"' <<< "$status" >/dev/null \
    || refuse "$code: trusted $context success is required"
  url=$(jq -r '.target_url' <<< "$status")
  local prefix="https://github.com/$repo/actions/runs/"
  [[ "$url" == "$prefix"* ]] || refuse "$code: invalid run link"
  run_id="${url#"$prefix"}"
  [[ "$run_id" =~ ^[1-9][0-9]*$ ]] || refuse "$code: invalid run id"
  run=$(bash "$gh_retry_script" api "repos/$repo/actions/runs/$run_id")
  jq -e --arg repo "$repo" --arg sha "$proof" --arg url "$url" --arg workflow "$workflow" --arg title "$title" --argjson id "$run_id" '
    .id == $id and .html_url == $url and .repository.full_name == $repo and
    .path == $workflow and .head_branch == "main" and
    (.event == "push" or .event == "workflow_dispatch" or .event == "schedule") and
    (.display_title | test("^(" + $title + ") " + $sha + "$")) and
    (.event == "workflow_dispatch" or .head_sha == $sha) and
    .status == "completed" and .conclusion == "success"
  ' <<< "$run" >/dev/null || refuse "$code: run provenance or conclusion does not match"
}
if [[ "$proof" != "$sha" || -n "$rc_tags" ]]; then
  # Title patterns follow each workflow's run-name (scripts/proof-run-titles.test.ts).
  # A commit carrying RC tags is proven only by a staging proof of one of
  # those tags: an ordinary main deploy builds its own images, and another
  # candidate's proof covers other digests.
  staging_title="Staging release proof v[0-9]+[.][0-9]+[.][0-9]+-rc[.][1-9][0-9]*|Deploy main to staging"
  if [[ -n "$rc_tags" ]]; then
    candidate_tags=$(grep -E '^v[0-9]+[.][0-9]+[.][0-9]+-rc[.][1-9][0-9]*$' <<< "$rc_tags" || true)
    [[ -n "$candidate_tags" ]] \
      || refuse "RELEASE_STAGING_NOT_GREEN: no well-formed RC tag points at $sha"
    staging_title="Staging release proof ($(sed 's/[.]/[.]/g' <<< "$candidate_tags" | paste -sd '|' -))"
  fi
  validate_workflow_status "staging/verified" ".github/workflows/deploy-staging.yml" "$staging_title" "RELEASE_STAGING_NOT_GREEN"
fi
if [[ "$receipt" != true ]]; then
  validate_workflow_status "main/heavy" ".github/workflows/main-heavy.yml" "Main heavy suites" "RELEASE_HEAVY_NOT_GREEN"
  validate_workflow_status "main/pr-depth" ".github/workflows/main-pr-depth.yml" "Main PR-depth checks" "RELEASE_PR_DEPTH_NOT_GREEN"
fi
bash "$script_dir/check-release-open-incidents.sh" "$repo"
