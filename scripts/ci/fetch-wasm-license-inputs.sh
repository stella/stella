#!/usr/bin/env bash
set -eo pipefail
for p in scan-engine heic-decoder pst-reader recording-wasm; do bash .github/actions/cargo-deny/fetch.sh packages/$p/Cargo.toml; done
