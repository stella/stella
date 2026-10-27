#!/usr/bin/env bash
# Every status write revalidates run and status ownership: listings can trail a
# newer run's status, so neither source alone proves this run still owns it.
set -euo pipefail
state="${1:?state is required}"
description="${2:?description is required}"
repo="${GITHUB_REPOSITORY:?repository is required}"
sha="${DEPLOY_SHA:?deploy SHA is required}"
run_id="${GITHUB_RUN_ID:?run ID is required}"
server="${GITHUB_SERVER_URL:-https://github.com}"
helper="${GH_RETRY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/gh-retry.sh}"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$sha" =~ ^[0-9a-f]{40}$ && "$run_id" =~ ^[1-9][0-9]*$ ]] || exit 2
url="$server/$repo/actions/runs/$run_id"
newest=$(bash "$helper" api "repos/$repo/actions/workflows/deploy-staging.yml/runs?event=workflow_dispatch&branch=main&per_page=100" |
  jq -r --arg repo "$repo" --arg title "Staging release proof $sha" --argjson run "$run_id" '
    [.workflow_runs[] | select(.repository.full_name == $repo and .head_branch == "main" and
      .path == ".github/workflows/deploy-staging.yml")] as $runs |
    ([$runs[] | select(.id == $run)][0]) as $current |
    # A blank-sha dispatch names its original main commit, while resolution
    # may select newer main. Derive that identity from this trusted run.
    ($current.event == "workflow_dispatch" and ($current.head_sha | type) == "string" and
      $current.display_title == ("Staging release proof " + $current.head_sha)) as $normal |
    [$runs[] | select(.display_title == $title or
      ($normal and .display_title == $current.display_title))][0].id // empty')
[[ "$newest" == "$run_id" ]] || { echo 'A newer staging run owns verification; leaving its status unchanged.'; exit 0; }
owner=$(bash "$helper" api --paginate --slurp "repos/$repo/commits/$sha/statuses?per_page=100" |
  jq -r '[.[][] | select(.context == "staging/verified" and .creator.login == "github-actions[bot]")][0].target_url // ""')
prefix="$server/$repo/actions/runs/"
if [[ "$owner" == "$prefix"* ]]; then
  owner_id="${owner#"$prefix"}"
  if [[ "$owner_id" =~ ^[1-9][0-9]*$ ]] && (( owner_id > run_id )); then
    echo 'A newer staging status owns verification; leaving it unchanged.'
    exit 0
  fi
fi
jq -n --arg state "$state" --arg description "$description" --arg url "$url" \
  '{state: $state, context: "staging/verified", description: $description, target_url: $url}' |
  bash "$helper" api "repos/$repo/statuses/$sha" --method POST --input - >/dev/null
