#!/usr/bin/env bash
# Runs `cargo test` (with the given arguments) in the current Rust package,
# under the toolchain its rust-toolchain.toml pins. Package tests run in
# parallel, and two rustup installs of the same toolchain at once leave it
# half installed, so the pinned toolchain (with its targets and components)
# is installed first under one lock per toolchain.
set -euo pipefail

if [[ ! -f rust-toolchain.toml ]]; then
  printf '%s: run it from a Rust package with a rust-toolchain.toml\n' "$0" >&2
  exit 2
fi
channel="$(sed -n 's/^channel = "\([^"]*\)"/\1/p' rust-toolchain.toml)"
readonly channel
readonly lock="${TMPDIR:-/tmp}/stella-rust-toolchain-${channel}.lock"
# A lock left by a killed run is taken over after ten minutes.
readonly wait_seconds=600

waited=0
until mkdir "${lock}" 2>/dev/null; do
  if ((waited >= wait_seconds)); then
    rm -rf "${lock}"
    waited=0
    continue
  fi
  sleep 1
  waited=$((waited + 1))
done
trap 'rmdir "${lock}" 2>/dev/null || true' EXIT
rustup toolchain install --no-self-update >/dev/null
rmdir "${lock}"
trap - EXIT

exec cargo test "$@"
