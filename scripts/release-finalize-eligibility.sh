#!/usr/bin/env bash
# Decides whether a completed proof run may finalize a release candidate.
# Prints `sha=<commit>` when it may; otherwise prints `reason=<code>` and a
# notice naming the refusal. Every refusal exits 0: most completions of these
# workflows are ordinary main runs, not candidate proofs.
#
# Usage: release-finalize-eligibility.sh <event.json> <owner/name>
# Reads tags from the git repository in the working directory.
set -euo pipefail
event="${1:?workflow_run event payload is required}"
repo="${2:?repository is required}"

refuse() {
  echo "reason=$1"
  echo "::notice::Finalize refused ($1): $2" >&2
  exit 0
}

field() { jq -er ".workflow_run.$1 // empty" "$event"; }

[[ "$(field head_repository.full_name || true)" == "$repo" ]] ||
  refuse foreign-repository "the proof run did not come from $repo"
[[ "$(field head_branch || true)" == "main" ]] ||
  refuse non-main-branch "the proof run did not run from main"
[[ "$(field event || true)" == "workflow_dispatch" ]] ||
  refuse non-dispatch-event "the proof run was not dispatched"
case "$(field path || true)" in
  .github/workflows/deploy-staging.yml | .github/workflows/main-heavy.yml | .github/workflows/main-pr-depth.yml) ;;
  *) refuse not-a-proof-workflow "the run is not a release proof workflow" ;;
esac
[[ "$(field conclusion || true)" == "success" ]] ||
  refuse unsuccessful-proof "the proof run did not succeed"

# The dispatched run's head_sha is main's tip; the proven commit is pinned in
# the run title. A staging proof also names its candidate tag
# (scripts/proof-run-titles.test.ts renders each workflow's run-name).
title="$(field display_title || true)"
title_pattern='^(Staging release proof (v[0-9]+\.[0-9]+\.[0-9]+-rc\.[1-9][0-9]*)|Main heavy suites|Main PR-depth checks) ([0-9a-f]{40})$'
[[ "$title" =~ $title_pattern ]] ||
  refuse not-a-proof-title "the run title names no exact commit"
named_rc="${BASH_REMATCH[2]}"
sha="${BASH_REMATCH[3]}"

rc=""
while IFS= read -r tag; do
  if [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[1-9][0-9]*$ ]]; then
    rc="$tag"
    break
  fi
done < <(git tag --points-at "$sha" --list 'v*-rc.*' --sort=-v:refname)
[[ -n "$rc" ]] || refuse untagged-commit "no release candidate tag targets $sha"
[[ -z "$named_rc" || "$named_rc" == "$rc" ]] ||
  refuse candidate-mismatch "the run names $named_rc but $sha carries $rc"
final="${rc%-rc.*}"
if git show-ref --verify --quiet "refs/tags/$final"; then
  refuse already-final "$final already exists"
fi

echo "sha=$sha"
