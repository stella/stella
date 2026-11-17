#!/usr/bin/env bash
# Lists the files a CI run's change touches for the dated waiver guard, then
# the tracked files the change's base already had (dated-waiver-base.ts).
#
# An expired waiver fails a run only when its change touches the entry
# declaring it; the scheduled healing run checks every waiver on the default
# branch and alerts its owner. A pull request or merge group changes
# everything since its target, and a push everything since the commit it moved
# from. A push whose base is not in the checkout checks nothing: the merge
# group already checked that change. Scheduled and dispatched runs on main
# change nothing themselves: each commit there passed a merge group that
# checked its change, so a date boundary never turns main red on its own.
set -euo pipefail

tracked="$RUNNER_TEMP/dated-waiver-tracked-files"
changed="$RUNNER_TEMP/dated-waiver-changed-files"
base=""
case "$GITHUB_EVENT_NAME" in
  pull_request | merge_group)
    target="origin/${TARGET_REF#refs/heads/}"
    base=$(git merge-base "$target" HEAD)
    git diff --name-only -z "$base" HEAD > "$changed"
    ;;
  push)
    if git cat-file -e "${PUSH_BEFORE}^{commit}" 2>/dev/null; then
      base="$PUSH_BEFORE"
      git diff --name-only -z "$base" HEAD > "$changed"
    else
      : > "$changed"
    fi
    ;;
  *) : > "$changed" ;;
esac
echo "DATED_WAIVER_CHANGED_FILES=$changed" >> "$GITHUB_ENV"
bun scripts/dated-waiver-base.ts "$base" "$tracked" "$changed" "$RUNNER_TEMP/dated-waiver-base-files"
