#!/usr/bin/env bash
# One-time manual bootstrap publish of the @stll dependency packages.
#
# npm trusted publishing (the publish-npm workflow's OIDC flow) can only be
# configured for a package name that already exists on the registry, so the
# FIRST publish of each package must be a manual, authenticated publish. After
# this succeeds, add a trusted publisher per package on npmjs.com (package
# settings -> Publishing) pointing at this repo + .github/workflows/publish-npm.yml,
# and use the workflow for every release thereafter.
#
# Per package: build, transform the package.json to its published dist shape,
# `bun publish` (Bun rewrites catalog:/workspace: deps; npm would not), then
# restore the source-shaped package.json.
#
# Requires npm auth (`npm whoami` must succeed) and a clean git tree.
# Run from the repo root.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is dirty; commit or stash first (this script restores package.json via git)." >&2
  exit 1
fi

# conditions before template-conditions (which depends on it); docx-utils is
# independent.
packages=(conditions template-conditions docx-utils)

for p in "${packages[@]}"; do
  echo "==> publishing @stll/${p}"
  (cd "packages/${p}" && bun run build)
  bun scripts/prepare-publish.ts "packages/${p}"
  (cd "packages/${p}" && bun publish --access public)
  git checkout -- "packages/${p}/package.json"
done

echo
echo "Published. Next: add an npm trusted publisher for each package on npmjs.com,"
echo "then use the 'Publish npm packages' workflow for subsequent releases."
