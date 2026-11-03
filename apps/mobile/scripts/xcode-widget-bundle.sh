#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$PROJECT_ROOT"
"$PODS_TARGET_SRCROOT/../scripts/with-node.sh" "$PROJECT_ROOT/scripts/build-widget-bundle.mjs"
"$PODS_TARGET_SRCROOT/../scripts/with-node.sh" "$PODS_TARGET_SRCROOT/../scripts/build-layout-registry.mjs" "$PROJECT_ROOT" ios
