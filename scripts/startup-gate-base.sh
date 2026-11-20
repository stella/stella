#!/usr/bin/env bash
# The base branch's copies of what the startup gates measure the pending
# layer against (scripts/bundle-startup-gates.ts): its bundle baseline, for
# the `pending` total, and its pending-component exceptions list, for how many
# routes the change converted. They are written at their repository paths
# under one directory, which STARTUP_GATE_BASE_DIR names for the gate step;
# a file the base lacks is left out. With no base commit the directory stays
# empty, and the gate measures from the tree's own total.
#
#   BASE=<commit> bash scripts/startup-gate-base.sh
set -euo pipefail

base="${BASE:-}"
dir="${RUNNER_TEMP:-/tmp}/startup-gate-base"
mkdir -p "$dir"
if [[ -n "$base" && ! "$base" =~ ^0+$ ]]; then
  bash "$(dirname "$0")/retry.sh" git fetch --no-tags --depth=1 origin "$base"
  for rel in scripts/bundle-baseline.json \
    .oxlint-plugins/route-pending-component-exceptions.json; do
    mkdir -p "$dir/$(dirname "$rel")"
    git show "$base:$rel" >"$dir/$rel" 2>/dev/null || rm -f "$dir/$rel"
  done
fi
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "STARTUP_GATE_BASE_DIR=$dir" >>"$GITHUB_ENV"
fi
