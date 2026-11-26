#!/usr/bin/env bash
set -eo pipefail
for p in scan-engine heic-decoder pst-reader recording-wasm; do cargo deny --offline --manifest-path packages/$p/Cargo.toml check --config packages/$p/deny.toml --hide-inclusion-graph bans licenses sources; done
