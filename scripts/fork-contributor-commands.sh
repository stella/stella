#!/usr/bin/env bash
#
# Runs the pre-push commands CONTRIBUTING.md gives fork contributors, the way
# a fresh fork clone runs them: a separate worktree of this commit, a plain
# `bun install`, then `bun run autofix` and the derived `bun run verify` plan,
# each without arguments. Pull requests from forks get no CI autofix and rely
# on these commands, so a change to the local harness must keep them running.
#
# Usage: bash scripts/fork-contributor-commands.sh
set -euo pipefail

repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/fork-contributor.XXXXXX")"
checkout="$work/checkout"
cleanup() {
  git -C "$repo" worktree remove --force "$checkout" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

git -C "$repo" worktree add --quiet --detach "$checkout" HEAD

# A fork clone has its submodules; reuse this checkout's copies instead of
# fetching them again.
while read -r name path; do
  if [[ -e "$repo/$path/.git" ]]; then
    git -C "$checkout" config "submodule.$name.url" "$repo/$path"
  fi
done < <(
  git -C "$checkout" config --file .gitmodules --get-regexp '^submodule\..*\.path$' |
    sed -E 's/^submodule\.(.*)\.path (.*)$/\1 \2/'
)
git -C "$checkout" -c protocol.file.allow=always submodule update --init --quiet

cd "$checkout"
# A contributor install runs the lifecycle scripts; it never sees a token.
NPM_TOKEN="" bun install --frozen-lockfile
bun run autofix
bun run verify --list
