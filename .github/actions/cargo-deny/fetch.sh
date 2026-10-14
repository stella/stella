#!/usr/bin/env bash
# Fetch the advisory database and crate index before an offline check. Only the
# download is retried; the check itself runs once against what was fetched.
set -euo pipefail

manifest="${1:?usage: fetch.sh <Cargo.toml>}"
attempts="${CARGO_DENY_FETCH_ATTEMPTS:-3}"
delay="${CARGO_DENY_FETCH_DELAY:-15}"

for ((attempt = 1; attempt <= attempts; attempt++)); do
  if cargo deny --manifest-path "$manifest" fetch db index; then
    exit 0
  fi
  if ((attempt < attempts)); then
    echo "::warning::cargo-deny fetch attempt ${attempt}/${attempts} failed; retrying in $((attempt * delay))s"
    sleep "$((attempt * delay))"
  fi
done
echo "::error::cargo-deny could not fetch the advisory database after ${attempts} attempts"
exit 1
