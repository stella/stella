#!/usr/bin/env bash
# Record release/staging-proof, the required status that carries the release
# candidate staging proof into a pull request and the merge queue.
#
# Every pull request head and merge group gets the status. A non-release
# pull request passes at once. A release pull request head carries the result
# of its staging proof run (deploy-staging.yml with release_candidate=true),
# written only by that run's own last job; a head with no proof run fails
# with the dispatch that starts one. Its merge group passes only when it
# lands exactly the proven tree on exactly the main the proof deployed with, which is what
# lets the version commit reuse the proof after merge instead of deploying a
# different tree.
#
# Usage:
#   release-staging-proof-status.sh pull-request <number>
#   release-staging-proof-status.sh open-pull-requests
#   release-staging-proof-status.sh merge-group <number> <group head> <resolved base>
#   release-staging-proof-status.sh finished-run <release head> <run id>
# NO_PROOF_REASON names why no proof was started for a release head;
# PROOF_DISPATCHED=true says this run just dispatched its staging proof;
# RELEASES_ONLY=true makes open-pull-requests skip non-release heads.
set -euo pipefail

context=release/staging-proof
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
server="${GITHUB_SERVER_URL:-https://github.com}"
gh_retry_script="${GH_RETRY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/gh-retry.sh}"
api() { bash "$gh_retry_script" api "$@"; }
usage() {
  echo 'usage: release-staging-proof-status.sh pull-request <number> | open-pull-requests | merge-group <number> <head> <base> | finished-run <sha> <run id>' >&2
  exit 2
}
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "::error::Invalid repository: $repo" >&2; exit 1; }
sha_pattern='^[0-9a-f]{40}$'

post() {
  local sha="$1" state="$2" description="$3" url="${4:-}"
  jq -n --arg state "$state" --arg context "$context" --arg description "${description:0:140}" --arg url "$url" \
    '{state: $state, context: $context, description: $description} + (if $url == "" then {} else {target_url: $url} end)' |
    api "repos/$repo/statuses/$sha" --method POST --input - > /dev/null
  printf '%s %s on %s: %s\n' "$context" "$state" "$sha" "$description"
}

# The same recognition rule as release-pull-requests.sh: a ready pull request
# into main, titled as a release, whose head branch lives in this repository.
is_release() {
  jq -e --arg repo "$repo" '
    .state == "open" and .draft == false and (.title | startswith("chore: release v")) and
    .head.repo.full_name == $repo and .base.repo.full_name == $repo and .base.ref == "main"
  ' <<< "$1" > /dev/null
}

# The newest staging/verified status a GitHub Actions run wrote on a commit.
latest_proof() {
  api --paginate --slurp "repos/$repo/commits/$1/statuses?per_page=100" | jq -c '
    [.[][] | select(.context == "staging/verified")][0] // {} |
    if .creator.login == "github-actions[bot]" and .creator.type == "Bot" then . else {} end
  '
}

# Write back the result a proof run already recorded on the head, if any.
# Writers of one head are not serialized, so a pending write for a run can
# land after that run's result; writing the result back after it keeps the
# result last in every interleaving. Fails when the run recorded none.
write_back() {
  local head="$1" url="$2" result
  result=$(api --paginate --slurp "repos/$repo/commits/$head/statuses?per_page=100" | jq -c --arg context "$context" --arg url "$url" '
    [.[][] | select(.context == $context and .target_url == $url and .creator.login == "github-actions[bot]" and
      (.state == "success" or .state == "failure" or .state == "error"))][0] // empty')
  [[ -n "$result" ]] || return 1
  post "$head" "$(jq -r '.state' <<< "$result")" "$(jq -r '.description' <<< "$result")" "$url"
}

# The newest deploy-staging proof run for a head, or {}.
newest_run() {
  api "repos/$repo/actions/workflows/deploy-staging.yml/runs?event=workflow_dispatch&branch=main&per_page=100" |
    jq -c --arg repo "$repo" --arg title "Staging release proof $1" '
      [.workflow_runs[] | select(.repository.full_name == $repo and .head_branch == "main" and
        .path == ".github/workflows/deploy-staging.yml" and .display_title == $title)][0] // {}'
}

# Reconcile a release head. It never derives a result from a run: a run's
# success or failure is written only by that run's own finished-run job. This
# path writes pending for an unfinished run, write-backs, and a failure that
# names the dispatch when the head has no proof run, or when its run is
# completed (so its own last job is over too) without having recorded one.
release_head() {
  local head="$1" run run_id url
  run=$(newest_run "$head")
  run_id=$(jq -r '.id // ""' <<< "$run")
  url=$(jq -r '.html_url // ""' <<< "$run")
  if [[ -z "$run_id" && "${PROOF_DISPATCHED:-}" == true ]]; then
    # The run listing can trail a dispatch that just succeeded; once listed,
    # the run's recorded result goes back on top of this pending write.
    post "$head" pending "Staging proof dispatched; waiting for its run to start"
    url=$(newest_run "$head" | jq -r '.html_url // ""')
    if [[ -n "$url" ]]; then write_back "$head" "$url" || true; fi
  elif [[ -z "$run_id" ]]; then
    post "$head" failure "${NO_PROOF_REASON:-No staging proof for this head; dispatch deploy-staging.yml release_candidate=true sha=$head}"
  elif [[ "$(jq -r '.status' <<< "$run")" != completed ]]; then
    post "$head" pending "Staging proof running: run $run_id" "$url"
    write_back "$head" "$url" || true
  else
    write_back "$head" "$url" ||
      post "$head" failure "Proof run $run_id recorded no result; dispatch deploy-staging.yml release_candidate=true sha=$head" "$url"
  fi
}

record_pull() {
  local pull="$1" head
  head=$(jq -r '.head.sha' <<< "$pull")
  [[ "$head" =~ $sha_pattern ]] || { echo "::error::Pull request $(jq -r '.number' <<< "$pull") has no head commit" >&2; exit 1; }
  if [[ "$(jq -r '.state' <<< "$pull")" != open ]]; then
    echo "Pull request $(jq -r '.number' <<< "$pull") is not open; nothing to record."
  elif is_release "$pull"; then
    release_head "$head"
  elif [[ "${RELEASES_ONLY:-}" != true ]]; then
    post "$head" success "Not a release pull request"
  fi
}

pull_request() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]] || usage
  record_pull "$(api "repos/$repo/pulls/$1")"
}

open_pull_requests() {
  local pulls pull
  pulls=$(api --paginate --slurp "repos/$repo/pulls?state=open&base=main&per_page=100" | jq -c '.[][]')
  while IFS= read -r pull; do
    if [[ -n "$pull" ]]; then record_pull "$pull"; fi
  done <<< "$pulls"
}

version_at() {
  local version
  version=$(api "repos/$repo/contents/VERSION?ref=$1" -H "Accept: application/vnd.github.raw") || return
  printf '%s\n' "${version//[[:space:]]/}"
}

# The group base is the shared resolver's (merge-target-base.sh): the merge
# base of main and the group head, so the group head carries every queue entry
# that lands with this one, not only the entry the queue ref names. A release
# merges alone: its group must hold exactly the proven tree on exactly the
# proven main, and any other group whose entries change VERSION fails.
merge_group() {
  local number="$1" group_head="$2" group_base="$3"
  [[ "$number" =~ ^[1-9][0-9]*$ && "$group_head" =~ $sha_pattern && "$group_base" =~ $sha_pattern ]] || usage
  local pull head proof group_tree head_tree group_version base_version
  pull=$(api "repos/$repo/pulls/$number")
  if ! is_release "$pull"; then
    # Assigned on their own so an unreadable VERSION stops the script.
    group_version=$(version_at "$group_head")
    base_version=$(version_at "$group_base")
    [[ -n "$group_version" && -n "$base_version" ]] || { echo "::error::VERSION is unreadable in the merge group" >&2; exit 1; }
    if [[ "$group_version" != "$base_version" ]]; then
      post "$group_head" failure "This merge group also lands a release; a release merges alone, so requeue after it lands"
    else
      post "$group_head" success "Not a release pull request"
    fi
    return
  fi
  head=$(jq -r '.head.sha' <<< "$pull")
  [[ "$head" =~ $sha_pattern ]] || { echo "::error::Pull request $number has no head commit" >&2; exit 1; }
  proof=$(latest_proof "$head")
  if ! jq -e '.state == "success"' <<< "$proof" > /dev/null; then
    post "$group_head" failure "Release head ${head:0:12} has no passing staging proof"
    return
  fi
  if ! jq -e --arg suffix "; main=$group_base" '.description | endswith($suffix)' <<< "$proof" > /dev/null; then
    post "$group_head" failure "Main moved since the staging proof; update the release branch to prove this base" "$(jq -r '.target_url // ""' <<< "$proof")"
    return
  fi
  group_tree=$(api "repos/$repo/commits/$group_head" | jq -r '.commit.tree.sha')
  head_tree=$(api "repos/$repo/commits/$head" | jq -r '.commit.tree.sha')
  if [[ ! "$group_tree" =~ $sha_pattern || "$group_tree" != "$head_tree" ]]; then
    post "$group_head" failure "Merge group tree differs from the proven release head ${head:0:12}; a release merges alone"
    return
  fi
  post "$group_head" success "Lands the proven tree of ${head:0:12}; main=$group_base" "$(jq -r '.target_url // ""' <<< "$proof")"
}

# The end of a release candidate staging run: its own staging/verified result
# is the proof, and a run that ended before writing one failed it.
finished_run() {
  local head="$1" run_id="$2"
  [[ "$head" =~ $sha_pattern && "$run_id" =~ ^[1-9][0-9]*$ ]] || usage
  local pulls run_url proof main
  pulls=$(api --paginate --slurp "repos/$repo/commits/$head/pulls?per_page=100")
  if ! jq -e --arg repo "$repo" --arg head "$head" '
    [.[][] | select(.head.sha == $head and .state == "open" and .draft == false and
      (.title | startswith("chore: release v")) and .head.repo.full_name == $repo and
      .base.repo.full_name == $repo and .base.ref == "main")] | length == 1
  ' <<< "$pulls" > /dev/null; then
    echo "$head is not the head of one open release pull request; nothing to record."
    return
  fi
  run_url="$server/$repo/actions/runs/$run_id"
  proof=$(latest_proof "$head")
  if jq -e --arg url "$run_url" '.state == "success" and .target_url == $url' <<< "$proof" > /dev/null &&
    main=$(jq -er '.description | capture("; main=(?<main>[0-9a-f]{40})$").main' <<< "$proof"); then
    post "$head" success "Staging proof passed; main=$main" "$run_url"
  else
    post "$head" failure "Staging proof failed: run $run_id" "$run_url"
  fi
}

case "${1:-}" in
  pull-request) [[ $# -eq 2 ]] || usage; pull_request "$2" ;;
  open-pull-requests) [[ $# -eq 1 ]] || usage; open_pull_requests ;;
  merge-group) [[ $# -eq 4 ]] || usage; merge_group "$2" "$3" "$4" ;;
  finished-run) [[ $# -eq 3 ]] || usage; finished_run "$2" "$3" ;;
  *) usage ;;
esac
