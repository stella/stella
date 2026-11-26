#!/usr/bin/env bash
set -eo pipefail
cargo deny --offline --manifest-path apps/desktop/src-tauri/Cargo.toml check --config apps/desktop/src-tauri/deny.toml --hide-inclusion-graph bans licenses sources
