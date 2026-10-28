#!/usr/bin/env bash
# Prepares the WebAssembly toolchain: crates for the locked build and the pinned wasm-bindgen CLI.
# With CARGO_NET_OFFLINE=true it only verifies that both are already present.
set -euo pipefail

readonly WASM_BINDGEN_VERSION="0.2.129"
CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly CRATE_DIR

wasm_bindgen_ready() {
  command -v wasm-bindgen >/dev/null 2>&1 &&
    [[ "$(wasm-bindgen --version)" == "wasm-bindgen ${WASM_BINDGEN_VERSION}" ]]
}

if [[ "${CARGO_NET_OFFLINE:-}" == "true" ]]; then
  if ! wasm_bindgen_ready; then
    printf 'wasm-bindgen %s is required offline; run %s without CARGO_NET_OFFLINE first.\n' \
      "${WASM_BINDGEN_VERSION}" "${BASH_SOURCE[0]}" >&2
    exit 1
  fi
  exit 0
fi

cd "${CRATE_DIR}"
# The offline build also resolves crates for the host platform (for example
# cpufeatures on x86_64), so fetch both targets.
host_target="$(rustc -vV | sed -n 's/^host: //p')"
cargo fetch --locked --target wasm32-unknown-unknown --target "${host_target}"
if ! wasm_bindgen_ready; then
  cargo install wasm-bindgen-cli --version "=${WASM_BINDGEN_VERSION}" --locked
fi
