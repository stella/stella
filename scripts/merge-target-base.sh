#!/usr/bin/env bash
# Resolves the commit a run compares its changes against and writes it as
# `base_sha` to $GITHUB_OUTPUT. A pull request compares against its base. A
# merge group compares against the merge base of the target branch and the
# group head, not the previous queue entry: the queue merges every earlier
# entry together with this one, so the group must certify all of their
# changes. Other events have no base (empty). A merge group whose target
# branch cannot be resolved fails, since an empty base would let a consumer
# compare HEAD with itself and skip its check.
#
# ci-plan runs the copy from the workflow's own revision (.workflow-tooling),
# so the tree being certified cannot change how its base is chosen.
#
# Inputs (environment): EVENT_NAME, PR_BASE_SHA, TARGET_REF, GITHUB_OUTPUT.
set -euo pipefail
base=""
if [[ "$EVENT_NAME" == pull_request ]]; then
  base="$PR_BASE_SHA"
elif [[ "$EVENT_NAME" == merge_group ]]; then
  ref="${TARGET_REF#refs/heads/}"
  fetch=(git fetch --quiet --no-tags --filter=blob:none)
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
