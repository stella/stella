#!/usr/bin/env bash
# Rebuilds every Rust WebAssembly package from a fresh Cargo cache and
# compares the build with its committed generated/ bindings. Each build goes
# to $RUNNER_TEMP/<package>-wasm, which CI uploads when they differ.
set -euo pipefail

readonly OUT="${RUNNER_TEMP:?RUNNER_TEMP names the directory builds go to}"

SCAN_ENGINE_WASM_OUT_DIR="${OUT}/scan-engine-wasm" \
  bash packages/scan-engine/scripts/test-wasm-offline.sh
HEIC_DECODER_WASM_OUT_DIR="${OUT}/heic-decoder-wasm" \
  bash packages/heic-decoder/scripts/test-wasm-offline.sh
PST_READER_WASM_OUT_DIR="${OUT}/pst-reader-wasm" \
  bash packages/pst-reader/scripts/test-wasm-offline.sh
