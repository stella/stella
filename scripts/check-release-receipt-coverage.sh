#!/usr/bin/env bash
# Read-only: may a merge-group ci-result receipt on the release commit stand in
# for main/heavy and main/pr-depth? A merge-group run validates only its own
# group's final diff, so the receipt covers the release only when every commit
# after a fully proven one (the newest earlier main commit with main/heavy and
# main/pr-depth green, else the previous release tag) reached main through a
# validated merge group.
# An admin merge or a direct push in that range, history this checkout cannot
# read, or a missing Bun all keep both statuses required: unknown is not safe.
#
# Exit 0: the receipt covers the release. Exit 1: no receipt on the commit.
# Exit 2: a receipt, but it does not cover the release history. Reasons go to
# stderr; stdout stays empty because callers forward it to step outputs.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gh_retry_script="${GH_RETRY_SCRIPT:-$script_dir/gh-retry.sh}"
tree_proof_verifier="${RELEASE_TREE_PROOF_VERIFIER:-$script_dir/verify-release-tree-proof.sh}"
queue_history="$script_dir/check-release-queue-history.ts"
# The queue history check reads this repository's pull requests and runs.
history_repository="stella/stella"
repo="${1:?repository is required}"
sha="${2:?commit SHA is required}"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo '::error::RELEASE_RECEIPT_COVERAGE: invalid repository or SHA' >&2; exit 1;
}

# The receipt is read on the release commit itself, never on a reused proof.
if ! bash "$tree_proof_verifier" --merge-group-receipt "$repo" "$sha"; then
  echo "No merge-group receipt on $sha; main/heavy and main/pr-depth are required." >&2
  exit 1
fi
not_covered() {
  echo "Merge-group receipt on $sha does not stand in for main/heavy and main/pr-depth: $1" >&2
  exit 2
}
[[ "$repo" == "$history_repository" ]] \
  || not_covered "the queue history check reads only $history_repository."
command -v bun >/dev/null 2>&1 \
  || not_covered "Bun is not available, so the release history cannot be checked."
previous_tag=$(git describe --tags --abbrev=0 --match 'v*' "$sha^" 2>/dev/null) && [[ -n "$previous_tag" ]] \
  || not_covered "no previous release tag is reachable from $sha in this checkout."
# The newest earlier main commit whose main/heavy and main/pr-depth both passed
# (the cut gate requires both on the cut base) anchors the history: its suites
# ran on its whole tree, so only the commits after it need merge-group
# validation. Without one since the previous tag, the tag is the anchor.
anchor="$previous_tag"
while read -r candidate; do
  [[ -n "$candidate" ]] || continue
  states=$(bash "$gh_retry_script" api "repos/$repo/commits/$candidate/statuses?per_page=100" \
    --jq '[.[] | select(.creator.login == "github-actions[bot]")] as $own
      | [($own | map(select(.context == "main/heavy")) | first | .state // "none"),
         ($own | map(select(.context == "main/pr-depth")) | first | .state // "none")] | join(" ")' \
    </dev/null) || continue
  if [[ "$states" == "success success" ]]; then
    anchor="$candidate"
    break
  fi
done < <(git rev-list --first-parent --max-count=50 "$previous_tag..$sha^" 2>/dev/null)
GH_RETRY_SCRIPT="$gh_retry_script" bun "$queue_history" --require \
  --from "$anchor" --base "$sha" --repo-dir "$PWD" >&2 \
  || not_covered "history since $anchor is not validated through the merge queue."
echo "Merge-group receipt on $sha and validated queue history since $anchor stand in for main/heavy and main/pr-depth." >&2
