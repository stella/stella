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
# All packages are authenticated, validated, built, transformed, and packed
# before the first registry write. `bun publish` rewrites catalog:/workspace:
# dependencies; npm would not. A trap restores every source-shaped manifest.
#
# Requires npm auth (`npm whoami` must succeed) and a clean git tree.
# Run from the repo root.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is dirty; commit or stash first (this script restores package.json via git)." >&2
  exit 1
fi

# First publication needs an npm token; trusted publishing can only be configured
# after each package exists. `template-conditions` depends on `conditions`;
# `anonymize-chat` depends on the already-published `anonymize-wasm` package.
packages=(auth-model ai-catalog anonymize-chat conditions template-conditions docx-utils)
manifests=()

require_placeholder_version() {
  local package_name="$1"
  local manifest="packages/${package_name}/package.json"
  local version
  version="$(jq -er '.version | strings' "$manifest")"
  if [[ "$version" != "0.0.0" ]]; then
    echo "error: @stll/${package_name} is ${version}; bootstrap only publishes the 0.0.0 placeholder." >&2
    exit 1
  fi
}

npm whoami >/dev/null

for p in "${packages[@]}"; do
  manifest="packages/${p}/package.json"
  manifests+=("$manifest")
  require_placeholder_version "$p"
  if registry_result="$(npm view "@stll/${p}" version 2>&1)"; then
    echo "error: @stll/${p} already exists on npm; refusing a bootstrap publish." >&2
    exit 1
  fi
  if [[ "$registry_result" != *"E404"* ]]; then
    echo "error: could not verify that @stll/${p} is absent from npm." >&2
    echo "$registry_result" >&2
    exit 1
  fi
done

cleanup() {
  git checkout -- "${manifests[@]}"
}
trap cleanup EXIT

for p in "${packages[@]}"; do
  echo "==> preparing @stll/${p}@0.0.0"
  (cd "packages/${p}" && bun run build)
  bun scripts/prepare-publish.ts "packages/${p}"
  require_placeholder_version "$p"
  (cd "packages/${p}" && bun pm pack --dry-run)
done

for p in "${packages[@]}"; do
  echo "==> publishing @stll/${p}@0.0.0"
  require_placeholder_version "$p"
  (cd "packages/${p}" && bun publish --ignore-scripts --access public)
done

cleanup
trap - EXIT

echo
echo "Published. Next: add an npm trusted publisher for each package on npmjs.com,"
echo "then use the 'Publish npm packages' workflow for subsequent releases."
