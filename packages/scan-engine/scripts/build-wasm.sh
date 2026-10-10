#!/usr/bin/env bash
set -euo pipefail

readonly WASM_BINDGEN_VERSION="0.2.104"
readonly CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly OUTPUT_DIR="${CRATE_DIR}/pkg"

cd "${CRATE_DIR}"
cargo build --target wasm32-unknown-unknown --release

if ! command -v wasm-bindgen >/dev/null 2>&1 || [[ "$(wasm-bindgen --version)" != "wasm-bindgen ${WASM_BINDGEN_VERSION}" ]]; then
  cargo install wasm-bindgen-cli --version "=${WASM_BINDGEN_VERSION}" --locked
fi

rm -rf "${OUTPUT_DIR}"
wasm-bindgen \
  --target web \
  --out-dir "${OUTPUT_DIR}" \
  --out-name scan_engine \
  "${CRATE_DIR}/target/wasm32-unknown-unknown/release/stella_scan_engine.wasm"
