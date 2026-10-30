#!/usr/bin/env bash
# Read-only release gate, run again immediately before the tag push: the commit
# needs staging/verified plus either a merge-group ci-result receipt on the
# commit itself whose queue history since the previous release tag is fully
# validated (check-release-receipt-coverage.sh), or trusted main/heavy and
# main/pr-depth success; sparse or skipped heavy runs provide no green evidence.
# A failed main/heavy run still counts when only its advisory marketing
# screenshot jobs failed (release-heavy-verdict.jq decides, and a warning names
# the run); every other failure, cancelled run or unreadable job list refuses.
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
heavy_verdict_filter="$script_dir/release-heavy-verdict.jq"
runs_prefix="https://github.com/$repo/actions/runs/"
# Exit 0 when the run behind status $1 belongs to workflow $2 and commit $3,
# carries title pattern $4 and ended with conclusion $5.
status_run_matches() {
  local status="$1" workflow="$2" commit="$3" title="$4" conclusion="$5" url run_id run
  url=$(jq -r '.target_url' <<< "$status")
  [[ "$url" == "$runs_prefix"* ]] || return 1
  run_id="${url#"$runs_prefix"}"
  [[ "$run_id" =~ ^[1-9][0-9]*$ ]] || return 1
  run=$(bash "$gh_retry_script" api "repos/$repo/actions/runs/$run_id") || return 1
  jq -e --arg repo "$repo" --arg sha "$commit" --arg url "$url" --arg workflow "$workflow" --arg title "$title" --arg conclusion "$conclusion" --argjson id "$run_id" '
    .id == $id and .html_url == $url and .repository.full_name == $repo and
    .path == $workflow and .head_branch == "main" and
    (.event == "push" or .event == "workflow_dispatch" or .event == "schedule") and
    (.display_title | test("^(" + $title + ") " + $sha + "$")) and
    (.event == "workflow_dispatch" or .head_sha == $sha) and
    .status == "completed" and .conclusion == $conclusion
  ' <<< "$run" >/dev/null
}
# Exit 0, with a warning naming the run, when main/heavy status $1 on commit $2
# is a plain failure of a trusted, well-formed run whose only unsuccessful jobs
# are advisory (marketing screenshots never gate a release). Any other state,
# conclusion, unreadable job list or unclassified job stays a refusal.
heavy_failed_only_in_advisory_jobs() {
  local status="$1" commit="$2" url run_id jobs total record record_dir verdict
  jq -e '.state == "failure" and .creator.login == "github-actions[bot]" and .creator.type == "Bot"' <<< "$status" >/dev/null || return 1
  status_run_matches "$status" ".github/workflows/main-heavy.yml" "$commit" "Main heavy suites" failure || return 1
  url=$(jq -r '.target_url' <<< "$status")
  run_id="${url#"$runs_prefix"}"
  jobs=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/actions/runs/$run_id/jobs?filter=latest&per_page=100") || return 1
  # The pages must add up to the API's own count, or a job went unread.
  total=$(jq -ce '.[0].total_count' <<< "$jobs") || return 1
  jobs=$(jq -c '[.[].jobs[]]' <<< "$jobs") || return 1
  # ci-result's required-jobs record: the only evidence of why it failed.
  record_dir=$(mktemp -d)
  record=null
  if bash "$gh_retry_script" run download "$run_id" -R "$repo" -n ci-required-summary -D "$record_dir" >/dev/null 2>&1; then
    record=$(jq -ce . "$record_dir/ci-required-summary.json" 2>/dev/null) || record=null
  fi
  rm -rf "$record_dir"
  verdict=$(jq -nc --argjson jobs "$jobs" --argjson total "$total" --argjson record "$record" --argjson run_id "$run_id" --arg head "$commit" -f "$heavy_verdict_filter") || return 1
  jq -e '.advisoryOnly' <<< "$verdict" >/dev/null || {
    echo "main/heavy failing jobs: $(jq -r '.blocking | join(", ")' <<< "$verdict")" >&2
    return 1
  }
  echo "::warning::main/heavy failed only in advisory jobs ($(jq -r '.advisory | join(", ")' <<< "$verdict")) on $commit: $url" >&2
}
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
  # The newest status of each required context that is neither missing nor
  # success; only an advisory-only main/heavy failure is excused.
  while IFS= read -r status; do
    [[ -n "$status" ]] || continue
    [[ "$(jq -r '.context' <<< "$status")" == main/heavy ]] \
      && heavy_failed_only_in_advisory_jobs "$status" "$sha" \
      || refuse 'RELEASE_STATUS_NOT_GREEN: target has a newer non-green status'
  done < <(jq -c --argjson contexts "$required_contexts" '
    [.[][]] as $all | $contexts[] | . as $context |
      ([$all[] | select(.context == $context)][0] // {state: "missing"}) as $status |
      select($status.state != "missing" and $status.state != "success") | $status
  ' <<< "$target_statuses")
fi
statuses=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/commits/$proof/statuses?per_page=100")
# Statuses arrive newest first, so a later failure replaces an earlier success.
verified=$(jq -r '[.[][] | select(.context == "staging/verified")][0].state // "missing"' <<< "$statuses")
[[ "$verified" == "success" ]] \
  || refuse "RELEASE_STATUS_NOT_GREEN: staging/verified = $verified on $proof; success is required"
validate_workflow_status() {
  local context="$1" workflow="$2" title="$3" code="$4" status url run_id
  status=$(jq -ce --arg context "$context" '[.[][] | select(.context == $context)][0] // error("missing status")' <<< "$statuses") \
    || refuse "$code: $context is missing on $proof"
  if ! jq -e '.state == "success" and .creator.login == "github-actions[bot]" and .creator.type == "Bot"' <<< "$status" >/dev/null; then
    [[ "$context" == main/heavy ]] && heavy_failed_only_in_advisory_jobs "$status" "$proof" \
      && return 0
    refuse "$code: trusted $context success is required"
  fi
  url=$(jq -r '.target_url' <<< "$status")
  [[ "$url" == "$runs_prefix"* ]] || refuse "$code: invalid run link"
  run_id="${url#"$runs_prefix"}"
  [[ "$run_id" =~ ^[1-9][0-9]*$ ]] || refuse "$code: invalid run id"
  status_run_matches "$status" "$workflow" "$proof" "$title" success \
    || refuse "$code: run provenance or conclusion does not match"
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
