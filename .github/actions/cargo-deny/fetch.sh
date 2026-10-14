#!/usr/bin/env bash
# Fetch what an offline cargo-deny check reads: every dependency crate for all
# targets (metadata needs each manifest, including crates the host build never
# downloads), plus any cargo-deny sources named after the manifest, such as
# `db index` for advisories. Only the download is retried; the check itself
# runs once against what was fetched.
set -euo pipefail

manifest="${1:?usage: fetch.sh <Cargo.toml> [cargo-deny fetch sources...]}"
shift
sources=("$@")
attempts="${CARGO_DENY_FETCH_ATTEMPTS:-3}"
delay="${CARGO_DENY_FETCH_DELAY:-15}"

fetch() {
  cargo fetch --locked --manifest-path "$manifest" || return
  if ((${#sources[@]} > 0)); then
    cargo deny --manifest-path "$manifest" fetch "${sources[@]}"
  fi
}

for ((attempt = 1; attempt <= attempts; attempt++)); do
  if fetch; then
    exit 0
  fi
  if ((attempt < attempts)); then
    echo "::warning::cargo-deny fetch attempt ${attempt}/${attempts} failed; retrying in $((attempt * delay))s"
    sleep "$((attempt * delay))"
  fi
done
echo "::error::cargo-deny inputs could not be fetched after ${attempts} attempts"
exit 1
