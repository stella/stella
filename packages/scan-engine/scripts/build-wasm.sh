#!/usr/bin/env bash
set -euo pipefail

readonly WASM_BINDGEN_VERSION="0.2.126"
readonly CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly COMMITTED_OUTPUT_DIR="${CRATE_DIR}/generated"
readonly CHECK_MODE="${1:-}"
readonly RESOLVED_CARGO_HOME="$(cd "${CARGO_HOME:-${HOME}/.cargo}" && pwd)"
readonly RUSTC_SYSROOT="$(rustc --print sysroot)"
TARGET_DIR="${CARGO_TARGET_DIR:-${CRATE_DIR}/target}"
if [[ "${TARGET_DIR}" != /* ]]; then
  TARGET_DIR="${CRATE_DIR}/${TARGET_DIR}"
fi
readonly TARGET_DIR
OUTPUT_DIR="${COMMITTED_OUTPUT_DIR}"

if [[ "${CHECK_MODE}" == "--check" ]]; then
  OUTPUT_DIR="$(mktemp -d)"
  trap 'rm -rf "${OUTPUT_DIR}"' EXIT
elif [[ -n "${CHECK_MODE}" ]]; then
  printf 'usage: %s [--check]\n' "$0" >&2
  exit 2
fi

cd "${CRATE_DIR}"
RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=${RESOLVED_CARGO_HOME}=/cargo --remap-path-prefix=${RUSTC_SYSROOT}=/rustc --remap-path-prefix=${CRATE_DIR}=/scan-engine" \
  cargo build --target wasm32-unknown-unknown --release

if ! command -v wasm-bindgen >/dev/null 2>&1 || [[ "$(wasm-bindgen --version)" != "wasm-bindgen ${WASM_BINDGEN_VERSION}" ]]; then
  cargo install wasm-bindgen-cli --version "=${WASM_BINDGEN_VERSION}" --locked
fi

rm -rf "${OUTPUT_DIR}"
wasm-bindgen \
  --target web \
  --out-dir "${OUTPUT_DIR}" \
  --out-name scan_engine \
  "${TARGET_DIR}/wasm32-unknown-unknown/release/stella_scan_engine.wasm"

for declaration in "${OUTPUT_DIR}"/*.d.ts; do
  perl -ni -e 'print unless m{^/\* (?:eslint|tslint)-disable \*/$}' "${declaration}"
done
bun "${CRATE_DIR}/../../scripts/run-oxfmt.ts" "${OUTPUT_DIR}"

if [[ "${CHECK_MODE}" == "--check" ]]; then
  diff --recursive --brief "${COMMITTED_OUTPUT_DIR}" "${OUTPUT_DIR}"
fi
