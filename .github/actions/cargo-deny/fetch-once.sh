#!/usr/bin/env bash
# One download attempt for fetch.sh: every dependency crate for all targets,
# then the cargo-deny sources named after the manifest. fetch.sh retries this
# script as a whole, so a failed source fetch also repeats the crate fetch.
set -euo pipefail

manifest="${1:?usage: fetch-once.sh <Cargo.toml> [cargo-deny fetch sources...]}"
shift

cargo fetch --locked --manifest-path "$manifest"
if (($# > 0)); then
  cargo deny --manifest-path "$manifest" fetch "$@"
fi
