#!/usr/bin/env bash
# Decides whether a completed proof run, or a production gate status set by a
# person, may finalize a release candidate. The final tag starts the production
# promote, so finalize-release.sh also waits for release/prod-gate=success on
# the candidate; setting that status re-enters here as a `status` event.
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
status_field() { jq -er ".$1 // empty" "$event"; }

named_rc=""
if jq -e 'has("workflow_run")' "$event" > /dev/null; then
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
else
  # A production gate status: only a person's success on release/prod-gate
  # names a commit; finalize-release.sh re-reads it from the API before tagging.
  [[ "$(status_field repository.full_name || true)" == "$repo" ]] ||
    refuse foreign-repository "the status was not set on $repo"
  [[ "$(status_field context || true)" == "release/prod-gate" ]] ||
    refuse not-a-prod-gate "the status is not release/prod-gate"
  [[ "$(status_field state || true)" == "success" ]] ||
    refuse prod-gate-not-success "release/prod-gate is not success"
  [[ "$(status_field sender.type || true)" == "User" ]] ||
    refuse prod-gate-not-a-person "release/prod-gate was not set by a person"
  sha="$(status_field sha || true)"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] ||
    refuse invalid-status-commit "the status names no exact commit"
fi

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
