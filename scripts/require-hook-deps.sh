#!/usr/bin/env bash
# Refuse to run the git hooks in a checkout that lacks what they import.
# The root workspace declares every package the hooks load or run
# (scripts/hook-dependencies.test.ts walks their imports and package
# executables to prove it); pass a workspace directory for a hook that also
# runs that workspace's code.
# A hook never installs on its own: an install rewrites node_modules under
# the person committing, takes minutes and needs the network. This script
# prints the exact install command instead and fails, so the commit stops
# before any hook runs half-equipped.
#
# Usage: bash scripts/require-hook-deps.sh [workspace-dir...]
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."

missing=()
[[ -d node_modules ]] || missing+=(.)
filters=(--filter ./)
for workspace in "$@"; do
  if [[ ! -d "$workspace/node_modules" ]]; then
    missing+=("$workspace")
    # A leading ./ makes the filter a path instead of a package name.
    filters+=(--filter "./${workspace#./}")
  fi
done
[[ ${#missing[@]} -eq 0 ]] && exit 0

{
  echo "error: the git hooks need dependencies this checkout has not installed: ${missing[*]}"
  echo "Install them from the repository root, then commit again:"
  echo "  bun install --frozen-lockfile --ignore-scripts ${filters[*]}"
  echo "A full \`bun install\` covers them too."
} >&2
exit 1
