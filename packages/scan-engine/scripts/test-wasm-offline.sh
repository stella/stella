#!/usr/bin/env bash
# Exercise dependency preparation without a registry or build cache.
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly CRATE_DIR
SCRATCH_DIR="$(mktemp -d)"
readonly SCRATCH_DIR
trap 'rm -rf "${SCRATCH_DIR}"' EXIT

export CARGO_HOME="${SCRATCH_DIR}/cargo"
export CARGO_TARGET_DIR="${SCRATCH_DIR}/target"
export SCAN_ENGINE_WASM_OUT_DIR="${SCAN_ENGINE_WASM_OUT_DIR:-${SCRATCH_DIR}/generated}"
export PATH="${CARGO_HOME}/bin:${PATH}"
mkdir -p "${CARGO_HOME}"

cd "${CRATE_DIR}"
# The fresh cache downloads everything once, retried as a unit; the build
# below then proves it needs nothing else.
CARGO_NET_OFFLINE=false bash ../../scripts/retry.sh bash scripts/wasm-toolchain.sh
CARGO_NET_OFFLINE=true bun run build:wasm
bun run check:wasm --check
