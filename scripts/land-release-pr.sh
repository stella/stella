#!/usr/bin/env bash
# Only trusted main tooling runs here; the finalized release tree is data.
set -euo pipefail
repo="${1:?repository is required}"
sha="${2:?finalized SHA is required}"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gh_retry_script="${GH_RETRY_SCRIPT:-$script_dir/gh-retry.sh}"
fail() {
  local message="$*"
  message="${message//%/%25}"
  message="${message//$'\r'/%0D}"
  message="${message//$'\n'/%0A}"
  echo "::error::$message" >&2
  exit 1
}
version=$(git show "$sha:VERSION" | tr -d '[:space:]')
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 2
final="v$version"
final_sha=$(git rev-parse --verify "refs/tags/$final^{commit}") || fail "Final tag $final is missing"
[[ "$final_sha" == "$sha" ]] || fail "Final tag $final targets $final_sha, expected $sha"
branch="release/$final"
listing=$(bash "$gh_retry_script" api graphql \
  -f owner="${repo%/*}" -f name="${repo#*/}" -f head="$branch" \
  -f query='query($owner: String!, $name: String!, $head: String!) {
    repository(owner: $owner, name: $name) {
      pullRequests(first: 100, headRefName: $head, baseRefName: "main", states: [OPEN, MERGED, CLOSED]) {
        nodes { number title state headRefName headRefOid isCrossRepository autoMergeRequest { enabledAt } isInMergeQueue }
        pageInfo { hasNextPage }
      }
    }
  }' --jq '.data.repository.pullRequests')
jq -e '.pageInfo.hasNextPage == false' <<<"$listing" >/dev/null \
  || fail "Incomplete PR listing for $branch: $listing"
pulls=$(jq '.nodes' <<<"$listing")
jq -e 'type == "array" and length < 100 and all(.[]; .isCrossRepository | type == "boolean")' <<<"$pulls" >/dev/null \
  || fail "Incomplete or invalid PR listing for $branch: $pulls"
# A fork can name its head branch release/vX.Y.Z; it is never the release PR.
pulls=$(jq 'map(select(.isCrossRepository | not))' <<<"$pulls")
jq -e 'type == "array" and length < 100 and all(.[];
  (.number | type == "number") and (.title | type == "string") and
  (.headRefName | type == "string") and (.headRefOid | test("^[0-9a-f]{40}$")) and
  (.isCrossRepository | type == "boolean") and (.isInMergeQueue | type == "boolean") and
  (.state == "OPEN" or .state == "MERGED" or .state == "CLOSED"))' <<<"$pulls" >/dev/null \
  || fail "Incomplete or invalid PR listing for $branch: $pulls"
found=$(jq -r 'map("#\(.number) \(.title) (\(.state), head \(.headRefOid))") | join("; ")' <<<"$pulls")
open=$(jq '[.[] | select(.state == "OPEN")]' <<<"$pulls")
count=$(jq 'length' <<<"$open")
if [[ "$count" == 0 ]]; then
  merged=$(jq --arg sha "$sha" --arg branch "$branch" '[.[] | select(.state == "MERGED" and .headRefOid == $sha and .headRefName == $branch and (.isCrossRepository | not))] | length' <<<"$pulls")
  [[ "$merged" == 1 ]] || fail "Expected one release PR for $branch at $sha; found: ${found:-none}"
  echo "Release PR for $final at $sha is already merged."
  exit 0
fi
[[ "$count" == 1 ]] || fail "Expected one open release PR for $branch at $sha; found: $found"
jq -e --arg sha "$sha" --arg branch "$branch" '.[0] | .headRefOid == $sha and .headRefName == $branch and (.isCrossRepository | not)' <<<"$open" >/dev/null \
  || fail "Release PR head mismatch for $branch; expected $sha; found: $found"
number=$(jq -r '.[0].number' <<<"$open")
if jq -e '.[0].isInMergeQueue' <<<"$open" >/dev/null; then
  echo "::notice::Release PR #$number at $sha is already in the merge queue."
  exit 0
fi
if jq -e '.[0].autoMergeRequest != null' <<<"$open" >/dev/null; then
  echo "Release PR #$number at $sha already has auto-merge enabled."
  exit 0
fi
bash "$gh_retry_script" pr merge "$number" --repo "$repo" --auto --match-head-commit "$sha"
