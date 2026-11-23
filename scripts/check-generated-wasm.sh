#!/usr/bin/env bash
# Rebuilds each named Rust WebAssembly package (packages/<name>) from a fresh
# Cargo cache and compares the build with its committed generated/ bindings.
# Each build goes to $RUNNER_TEMP/<name>-wasm, named to its package script
# by <NAME>_WASM_OUT_DIR; CI uploads those directories when they differ.
# usage: check-generated-wasm.sh packages/<name>...
set -euo pipefail

readonly OUT="${RUNNER_TEMP:?RUNNER_TEMP names the directory builds go to}"

if [[ $# -eq 0 ]]; then
  printf 'usage: %s packages/<name>...\n' "$0" >&2
  exit 2
fi

for package in "$@"; do
  name="$(basename "${package}")"
  variable="$(printf '%s' "${name}" | tr 'a-z-' 'A-Z_')_WASM_OUT_DIR"
  env "${variable}=${OUT}/${name}-wasm" \
    bash "${package}/scripts/test-wasm-offline.sh"
done
