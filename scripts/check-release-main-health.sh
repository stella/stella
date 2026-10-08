#!/usr/bin/env bash
# Read-only release gate, run again immediately before the tag push: the commit
# needs staging/verified and trusted main/heavy success, and sparse or skipped
# heavy runs provide no green evidence.
set -euo pipefail

gh_retry_script="${GH_RETRY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/gh-retry.sh}"
repo="${1:?repository is required}"
sha="${2:?commit SHA is required}"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo '::error::RELEASE_HEAVY_NOT_GREEN: invalid repository or SHA' >&2; exit 1;
}
refuse() { echo "::error::$1" >&2; exit 1; }
statuses=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/commits/$sha/statuses?per_page=100")
# Statuses arrive newest first, so a later failure replaces an earlier success.
verified=$(jq -r '[.[][] | select(.context == "staging/verified")][0].state // "missing"' <<< "$statuses")
[[ "$verified" == "success" ]] \
  || refuse "RELEASE_STATUS_NOT_GREEN: staging/verified = $verified on $sha; success is required"
status=$(jq -ce '[.[][] | select(.context == "main/heavy")][0] // error("missing main/heavy")' <<< "$statuses") \
  || refuse "RELEASE_HEAVY_NOT_GREEN: main/heavy is missing on $sha"
jq -e '.state == "success" and .creator.login == "github-actions[bot]" and .creator.type == "Bot"' <<< "$status" >/dev/null \
  || refuse 'RELEASE_HEAVY_NOT_GREEN: trusted main/heavy success is required'
url=$(jq -r '.target_url' <<< "$status")
prefix="https://github.com/$repo/actions/runs/"
[[ "$url" == "$prefix"* ]] || refuse 'RELEASE_HEAVY_NOT_GREEN: invalid heavy run link'
run_id="${url#"$prefix"}"
[[ "$run_id" =~ ^[1-9][0-9]*$ ]] || refuse 'RELEASE_HEAVY_NOT_GREEN: invalid heavy run id'
run=$(bash "$gh_retry_script" api "repos/$repo/actions/runs/$run_id")
jq -e --arg repo "$repo" --arg sha "$sha" --arg url "$url" --argjson id "$run_id" '
  .id == $id and .html_url == $url and .repository.full_name == $repo and
  .path == ".github/workflows/main-heavy.yml" and .head_branch == "main" and
  (.event == "push" or .event == "workflow_dispatch" or .event == "schedule") and
  .display_title == ("Main heavy suites " + $sha) and
  (.event == "workflow_dispatch" or .head_sha == $sha) and
  .status == "completed" and .conclusion == "success"
' <<< "$run" >/dev/null || refuse 'RELEASE_HEAVY_NOT_GREEN: heavy run provenance or conclusion does not match'
comparison=$(bash "$gh_retry_script" api "repos/$repo/compare/$sha...main")
jq -e --arg sha "$sha" '(.status == "ahead" or .status == "identical") and .merge_base_commit.sha == $sha' <<< "$comparison" >/dev/null \
  || refuse 'RELEASE_HEAVY_NOT_GREEN: candidate is not on main'
incidents=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/issues?state=open&labels=main-health-incident&per_page=100")
jq -e '[.[][]] | length == 0' <<< "$incidents" >/dev/null \
  || refuse 'RELEASE_OPEN_MAIN_INCIDENT: an unresolved main-health incident blocks tagging'
