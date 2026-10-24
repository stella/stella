#!/usr/bin/env bash
# Install only what the git hooks import, once, in a checkout that has no
# dependencies yet. The root workspace declares every package the hooks load
# or run (scripts/hook-dependencies.test.ts walks their imports and package
# executables to prove it); pass a workspace directory for a hook that also
# runs that workspace's code.
# A full `bun install` covers all of this, so a checkout that has one is a
# no-op. Lifecycle scripts stay off: the hooks never need generated files.
#
# Usage: bash scripts/ensure-hook-deps.sh [workspace-dir...]
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

echo "Installing git hook dependencies for: ${missing[*]}"
exec bun install --frozen-lockfile --ignore-scripts "${filters[@]}"
