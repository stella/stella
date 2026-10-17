#!/usr/bin/env bash
# Fetch what an offline cargo-deny check reads: every dependency crate for all
# targets (metadata needs each manifest, including crates the host build never
# downloads), plus any cargo-deny sources named after the manifest, such as
# `db index` for advisories. Only the download is retried, as one unit through
# scripts/retry.sh; the check itself runs once against what was fetched.
set -euo pipefail

: "${1:?usage: fetch.sh <Cargo.toml> [cargo-deny fetch sources...]}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
delay="${CARGO_DENY_FETCH_DELAY:-15}"

RETRY_ATTEMPTS="${CARGO_DENY_FETCH_ATTEMPTS:-3}" \
  RETRY_DELAYS_SECONDS="${delay} $((delay * 2))" \
  bash "$here/../../../scripts/retry.sh" bash "$here/fetch-once.sh" "$@"
