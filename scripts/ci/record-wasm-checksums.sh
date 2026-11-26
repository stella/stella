#!/usr/bin/env bash
set -eo pipefail
if [[ -d "$RUNNER_TEMP/scan-engine-wasm" ]]; then
  (cd "$RUNNER_TEMP/scan-engine-wasm" && sha256sum ./*) > "$RUNNER_TEMP/scan-engine-wasm.sha256"
  rustc -vV > "$RUNNER_TEMP/scan-engine-wasm.toolchain"
fi
