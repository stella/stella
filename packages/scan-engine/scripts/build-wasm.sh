#!/usr/bin/env bash
# Builds the WebAssembly target and its web bindings into generated/, or into
# SCAN_ENGINE_WASM_OUT_DIR when set (the drift check compares that copy).
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly CRATE_DIR
readonly OUTPUT_DIR="${SCAN_ENGINE_WASM_OUT_DIR:-${CRATE_DIR}/generated}"
readonly CANONICAL_RUST_HOST="x86_64-unknown-linux-gnu"

if [[ $# -ne 0 ]]; then
  printf 'usage: %s\n' "$0" >&2
  exit 2
fi

cd "${CRATE_DIR}"
PINNED_RUST_VERSION="$(sed -n 's/^channel = "\([^"]*\)"/\1/p' rust-toolchain.toml)"
readonly PINNED_RUST_VERSION
RUSTC_METADATA="$("${RUSTC:-rustc}" -vV)"
readonly RUSTC_METADATA
RUSTC_HOST="$(printf '%s\n' "${RUSTC_METADATA}" | sed -n 's/^host: //p')"
readonly RUSTC_HOST
RUSTC_RELEASE="$(printf '%s\n' "${RUSTC_METADATA}" | sed -n 's/^release: //p')"
readonly RUSTC_RELEASE
if [[ "${RUSTC_HOST}" != "${CANONICAL_RUST_HOST}" || "${RUSTC_RELEASE}" != "${PINNED_RUST_VERSION}" ]]; then
  printf 'Scan engine WASM generation requires x86_64 Linux with Rust %s (found %s, Rust %s). Use the scan-engine-wasm CI artifact to update generated/.\n' \
    "${PINNED_RUST_VERSION}" "${RUSTC_HOST}" "${RUSTC_RELEASE}" >&2
  exit 2
fi

RESOLVED_CARGO_HOME="$(cd "${CARGO_HOME:-${HOME}/.cargo}" && pwd)"
readonly RESOLVED_CARGO_HOME
RUSTC_SYSROOT="$("${RUSTC:-rustc}" --print sysroot)"
readonly RUSTC_SYSROOT
TARGET_DIR="${CARGO_TARGET_DIR:-${CRATE_DIR}/target}"
if [[ "${TARGET_DIR}" != /* ]]; then
  TARGET_DIR="${CRATE_DIR}/${TARGET_DIR}"
fi
readonly TARGET_DIR

bash "${CRATE_DIR}/scripts/wasm-toolchain.sh"

cd "${CRATE_DIR}"
RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=${RESOLVED_CARGO_HOME}=/cargo --remap-path-prefix=${RUSTC_SYSROOT}=/rustc --remap-path-prefix=${CRATE_DIR}=/scan-engine" \
  cargo build --target wasm32-unknown-unknown --release --locked

rm -rf "${OUTPUT_DIR}"
wasm-bindgen \
  --target web \
  --out-dir "${OUTPUT_DIR}" \
  --out-name scan_engine \
  "${TARGET_DIR}/wasm32-unknown-unknown/release/stella_scan_engine.wasm"

# The engine owns instance recovery; wasm-bindgen's web glue would otherwise return its cached instance.
perl -0pi -e 's/  if \(wasm !== undefined\) return wasm;\n//g' "${OUTPUT_DIR}/scan_engine.js"

for declaration in "${OUTPUT_DIR}"/*.d.ts; do
  perl -ni -e 'print unless m{^/\* (?:eslint|tslint)-disable \*/$}' "${declaration}"
done
bun fmt "${OUTPUT_DIR}"
