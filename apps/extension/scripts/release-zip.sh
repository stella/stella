#!/usr/bin/env bash
set -euo pipefail

# Presence of this source-side script marks tags supporting store packages.
: "${VERSION:?Release version required}"
: "${RUNNER_TEMP:?Runner temporary directory required}"

bun ci --filter @stll/extension --ignore-scripts
bun --filter @stll/extension zip
# Check the packaged manifest, rather than only the build directory.
unzip -p "apps/extension/.output/stella-extension-chrome-${VERSION}.zip" manifest.json > "$RUNNER_TEMP/extension-manifest.json"
bun apps/extension/scripts/assert-manifest.ts production "$VERSION" "$RUNNER_TEMP/extension-manifest.json"
