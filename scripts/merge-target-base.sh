#!/usr/bin/env bash
# Resolves the commit a run compares its changes against and writes it as
# `base_sha` to $GITHUB_OUTPUT. A pull request run checks out GitHub's merge
# commit of its head onto the base branch tip and compares against that tip
# (the merge commit's first parent). The event's base.sha is the tip recorded
# when the pull request last synchronized and can lag it by many commits,
# each of which would otherwise count as part of this change. Any other
# checkout (a merge whose second parent is not the pull request head, or a
# shallow clone that lists no parents) keeps the event's base. A merge group compares against the merge base of the target branch and the
# group head, not the previous queue entry: the queue merges every earlier
# entry together with this one, so the group must certify all of their
# changes. Other events have no base (empty). A merge group whose target
# branch cannot be resolved fails, since an empty base would let a consumer
# compare HEAD with itself and skip its check.
#
# ci-plan runs the copy from the workflow's own revision (.workflow-tooling),
# so the tree being certified cannot change how its base is chosen.
#
# Inputs (environment): EVENT_NAME, PR_BASE_SHA, PR_HEAD_SHA, TARGET_REF,
# GITHUB_OUTPUT.
set -euo pipefail
retry_script="$(dirname "${BASH_SOURCE[0]}")/retry.sh"
base=""
if [[ "$EVENT_NAME" == pull_request ]]; then
  base="$PR_BASE_SHA"
  read -r -a commits <<<"$(git rev-list --parents -n 1 HEAD 2>/dev/null || true)"
  if [[ ${#commits[@]} -eq 3 && -n "${PR_HEAD_SHA:-}" && "${commits[2]}" == "$PR_HEAD_SHA" ]]; then
    base="${commits[1]}"
  fi
elif [[ "$EVENT_NAME" == merge_group ]]; then
  ref="${TARGET_REF#refs/heads/}"
  fetch=(bash "$retry_script" git fetch --quiet --no-tags --filter=blob:none)
  if [[ "$(git rev-parse --is-shallow-repository)" == true ]]; then
    fetch+=(--unshallow)
  fi
  if [[ -n "$ref" ]] && "${fetch[@]}" origin "$ref" &&
    target="$(git rev-parse FETCH_HEAD)" &&
    merge_base="$(git merge-base "$target" HEAD)"; then
    base="$merge_base"
    echo "Merge group compares against $ref at merge base $base."
  else
    echo "::error::Cannot resolve the merge group's target branch; refusing to plan against an unknown base."
    exit 1
  fi
fi
echo "base_sha=$base" >> "$GITHUB_OUTPUT"
