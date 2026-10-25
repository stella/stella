#!/usr/bin/env bash
# Record release/staging-proof, the required status that carries the release
# candidate staging proof into a pull request and the merge queue.
#
# Every pull request head and merge group gets the status. A non-release
# pull request passes at once. A release pull request head mirrors the
# staging proof of that exact head (deploy-staging.yml with
# release_candidate=true). Its merge group passes only when it lands exactly
# the proven tree on exactly the main the proof deployed with, which is what
# lets the version commit reuse the proof after merge instead of deploying a
# different tree.
#
# Usage:
#   release-staging-proof-status.sh pull-request <number>
#   release-staging-proof-status.sh open-pull-requests
#   release-staging-proof-status.sh merge-group <number> <group head> <group base>
#   release-staging-proof-status.sh finished-run <release head> <run id>
# NO_PROOF_REASON names why no proof was started for a release head.
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

# Reconcile a release head with its staging proof as GitHub records it now.
release_head() {
  local head="$1" proof runs run state run_url
  proof=$(latest_proof "$head")
  state=$(jq -r '.state // ""' <<< "$proof")
  run_url=$(jq -r '.target_url // ""' <<< "$proof")
  case "$state" in
    success)
      if main=$(jq -er '.description | capture("; main=(?<main>[0-9a-f]{40})$").main' <<< "$proof"); then
        post "$head" success "Staging proof passed; main=$main" "$run_url"
      else
        post "$head" failure "Staging proof is not bound to the main it deployed with" "$run_url"
      fi
      return
      ;;
    failure | error) post "$head" failure "Staging proof failed; re-run the staging proof run" "$run_url"; return ;;
    pending) post "$head" pending "Staging proof running" "$run_url"; return ;;
  esac
  runs=$(api "repos/$repo/actions/workflows/deploy-staging.yml/runs?event=workflow_dispatch&branch=main&per_page=100")
  run=$(jq -c --arg repo "$repo" --arg title "Staging release proof $head" '
    [.workflow_runs[] | select(.repository.full_name == $repo and .head_branch == "main" and
      .path == ".github/workflows/deploy-staging.yml" and .display_title == $title)][0] // {}
  ' <<< "$runs")
  if [[ "$(jq -r '.id // ""' <<< "$run")" == "" ]]; then
    post "$head" failure "${NO_PROOF_REASON:-No staging proof was started for this head; push to the release branch to start one}"
  elif [[ "$(jq -r '.status' <<< "$run")" != completed ]]; then
    post "$head" pending "Staging proof running: run $(jq -r '.id' <<< "$run")" "$(jq -r '.html_url' <<< "$run")"
  else
    post "$head" failure "Staging proof run $(jq -r '.id' <<< "$run") ended $(jq -r '.conclusion' <<< "$run") before staging verified it" "$(jq -r '.html_url' <<< "$run")"
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
  else
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

merge_group() {
  local number="$1" group_head="$2" group_base="$3"
  [[ "$number" =~ ^[1-9][0-9]*$ && "$group_head" =~ $sha_pattern && "$group_base" =~ $sha_pattern ]] || usage
  local pull head proof group_tree head_tree
  pull=$(api "repos/$repo/pulls/$number")
  if ! is_release "$pull"; then
    post "$group_head" success "Not a release pull request"
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
    post "$group_head" failure "Merge group tree differs from the proven release head ${head:0:12}"
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
