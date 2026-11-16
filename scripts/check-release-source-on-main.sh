#!/usr/bin/env bash
# Accepts a release source commit only when protected main carries it:
#   (1) the commit is an ancestor of origin/main; or
#   (2) a release ref vX.Y.Z is given, and the commit is the head of exactly
#       one pull request merged into main from that release's branch in this
#       repository (scripts/release-branch.sh names it), whose merge commit is
#       an ancestor of origin/main. Release branches are squash-merged, so
#       their head is not on main itself.
# Anything else, including a failed GitHub API read, refuses.
#
# Usage: check-release-source-on-main.sh <sha> [<release-ref vX.Y.Z>]
# Run inside a repository where origin/main and the commit are fetched.
# Requires GH_RETRY_SCRIPT (scripts/gh-retry.sh) and GITHUB_REPOSITORY.
set -euo pipefail

sha=${1:-}
release_ref=${2:-}
refuse() {
  echo "::error::$1" >&2
  exit 1
}

main='origin/main'
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || refuse 'Release source must be a full lowercase commit SHA.'
git rev-parse --verify --quiet "refs/remotes/${main}" >/dev/null \
  || refuse "${main} is not fetched."

if git merge-base --is-ancestor "$sha" "refs/remotes/${main}" 2>/dev/null; then
  exit 0
fi

[[ -n "$release_ref" ]] \
  || refuse "Release source ${sha} is not reachable from protected main."
[[ "$release_ref" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]] \
  || refuse "Release ref '${release_ref}' is not a stable vX.Y.Z release."
version=${BASH_REMATCH[1]}
# shellcheck source=scripts/release-branch.sh
source "$(dirname "${BASH_SOURCE[0]}")/release-branch.sh"
branch=$(release_branch "$version") \
  || refuse "Could not name the release branch for ${release_ref}."
[[ -n "${GH_RETRY_SCRIPT:-}" ]] || refuse 'GH_RETRY_SCRIPT must name the GitHub API retry wrapper.'
[[ -n "${GITHUB_REPOSITORY:-}" ]] || refuse 'GITHUB_REPOSITORY is not set.'

pulls=$(bash "$GH_RETRY_SCRIPT" api "repos/${GITHUB_REPOSITORY}/commits/${sha}/pulls") \
  || refuse "Could not list the pull requests of release source ${sha}."

merge_commit=$(jq -er --arg sha "$sha" --arg repo "$GITHUB_REPOSITORY" --arg branch "$branch" '
  if type == "array" and length == 1
    and (.[0].merged_at | type) == "string"
    and .[0].base.ref == "main"
    and .[0].base.repo.full_name == $repo
    and .[0].head.ref == $branch
    and .[0].head.repo.full_name == $repo
    and .[0].head.sha == $sha
  then .[0].merge_commit_sha | strings
  else empty
  end' <<< "$pulls" 2>/dev/null) || merge_commit=''

if [[ "$merge_commit" =~ ^[0-9a-f]{40}$ ]] \
  && git merge-base --is-ancestor "$merge_commit" "refs/remotes/${main}" 2>/dev/null; then
  exit 0
fi

refuse "Release source ${sha} is not carried by protected main through ${branch}."
