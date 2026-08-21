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
# before the first registry write. The transform rewrites catalog:/workspace:
# dependencies; npm then publishes the exact preflighted archives. A trap
# restores every source-shaped manifest.
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
integrities=()
publish_modes=()
tarballs=()

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
done

staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/stella-bootstrap-publish.XXXXXX")"

cleanup() {
  git checkout -- "${manifests[@]}"
  rm -rf -- "$staging_dir"
}
trap cleanup EXIT

for p in "${packages[@]}"; do
  echo "==> preparing @stll/${p}@0.0.0"
  (cd "packages/${p}" && bun run build)
  bun scripts/prepare-publish.ts "packages/${p}"
  require_placeholder_version "$p"
  pack_json="$(
    cd "packages/${p}"
    npm pack --json --ignore-scripts --pack-destination "$staging_dir"
  )"
  packed_name="$(jq -er '.[0].name | strings' <<<"$pack_json")"
  packed_version="$(jq -er '.[0].version | strings' <<<"$pack_json")"
  packed_filename="$(jq -er '.[0].filename | strings' <<<"$pack_json")"
  packed_integrity="$(jq -er '.[0].integrity | strings' <<<"$pack_json")"
  if [[ "$packed_name" != "@stll/${p}" || "$packed_version" != "0.0.0" ]]; then
    echo "error: packed artifact identity is ${packed_name}@${packed_version}; expected @stll/${p}@0.0.0." >&2
    exit 1
  fi
  tarballs+=("${staging_dir}/${packed_filename}")
  integrities+=("$packed_integrity")
done

for index in "${!packages[@]}"; do
  p="${packages[$index]}"
  package_name="@stll/${p}"
  if registry_result="$(npm view "$package_name" version 2>&1)"; then
    if ! registry_integrity="$(npm view "${package_name}@0.0.0" dist.integrity 2>&1)"; then
      echo "error: ${package_name} exists, but its 0.0.0 artifact could not be verified." >&2
      echo "$registry_integrity" >&2
      exit 1
    fi
    if [[ "$registry_integrity" != "${integrities[$index]}" ]]; then
      echo "error: ${package_name}@0.0.0 exists with an unexpected artifact; refusing to continue." >&2
      exit 1
    fi
    publish_modes+=(skip)
    continue
  fi
  if [[ "$registry_result" != *"E404"* ]]; then
    echo "error: could not verify that ${package_name} is absent from npm." >&2
    echo "$registry_result" >&2
    exit 1
  fi
  publish_modes+=(publish)
done

for index in "${!packages[@]}"; do
  p="${packages[$index]}"
  if [[ "${publish_modes[$index]}" == "skip" ]]; then
    echo "==> @stll/${p}@0.0.0 already matches the preflighted artifact; skipping"
    continue
  fi
  echo "==> publishing @stll/${p}@0.0.0"
  require_placeholder_version "$p"
  npm publish "${tarballs[$index]}" --ignore-scripts --access public
done

cleanup
trap - EXIT

echo
echo "Published. Next: add an npm trusted publisher for each package on npmjs.com,"
echo "then use the 'Publish npm packages' workflow for subsequent releases."
