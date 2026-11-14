#!/usr/bin/env bash
# Runs scripts/build-wasm.sh unchanged inside the canonical linux/amd64 Rust
# image, so a host that cannot build the committed WASM itself (macOS, ARM64
# Linux) regenerates generated/ byte for byte as CI does. Needs Docker; on an
# ARM64 host the image runs under emulation.
#
# Crates, the pinned wasm-bindgen CLI, the wasm32 target and the build cache
# live in Docker volumes named after the pinned toolchain, never in the host's
# ~/.cargo.
set -euo pipefail

# Official images pinned by digest. The Rust tag must match
# rust-toolchain.toml and the Bun tag bun-toolchain.json; both are checked
# below. bun formats the generated glue as the last build step.
readonly RUST_IMAGE="docker.io/library/rust:1.99.1-bookworm@sha256:48b7f435b8fc6378ce43b44f15e3a47fd8919b2825f835c39bd4bd3da50af5b8"
readonly BUN_IMAGE="docker.io/oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4"
readonly PLATFORM="linux/amd64"

if [[ $# -ne 0 ]]; then
  printf 'usage: %s\n' "$0" >&2
  exit 2
fi

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly CRATE_DIR
REPO_DIR="$(cd "${CRATE_DIR}/../.." && pwd)"
readonly REPO_DIR

PINNED_RUST_VERSION="$(sed -n 's/^channel = "\([^"]*\)"/\1/p' "${CRATE_DIR}/rust-toolchain.toml")"
readonly PINNED_RUST_VERSION
PINNED_BUN_VERSION="$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "${REPO_DIR}/bun-toolchain.json")"
readonly PINNED_BUN_VERSION
if [[ "${RUST_IMAGE}" != *":${PINNED_RUST_VERSION}-bookworm@sha256:"* ]]; then
  printf '%s pins Rust %s, but rust-toolchain.toml pins %s. Update RUST_IMAGE (tag and digest) with the toolchain.\n' \
    "$0" "${RUST_IMAGE}" "${PINNED_RUST_VERSION}" >&2
  exit 2
fi
if [[ "${BUN_IMAGE}" != *":${PINNED_BUN_VERSION}-slim@sha256:"* ]]; then
  printf '%s pins %s, but bun-toolchain.json pins Bun %s. Update BUN_IMAGE (tag and digest) with it.\n' \
    "$0" "${BUN_IMAGE}" "${PINNED_BUN_VERSION}" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  printf 'The container build needs Docker (or a compatible runtime such as OrbStack) on PATH.\n' >&2
  exit 2
fi

readonly VOLUME_PREFIX="stella-scan-engine-wasm-rust-${PINNED_RUST_VERSION}"

# The Bun binary comes from its own pinned image; copying it into a volume
# keeps the Rust image unmodified.
docker run --rm --platform "${PLATFORM}" \
  --volume "${VOLUME_PREFIX}-bun-${PINNED_BUN_VERSION}:/opt/bun" \
  --entrypoint /bin/sh \
  "${BUN_IMAGE}" \
  -c 'cp /usr/local/bin/bun /opt/bun/bun'

# The repository is mounted whole: bun fmt reads the formatter policy from the
# root bunfig.toml. The image's own CARGO_HOME keeps cargo and rustc; crates
# and the wasm-bindgen CLI go to a cache volume. The target directory is a
# volume too, so host build artifacts never mix with Linux ones.
docker run --rm --platform "${PLATFORM}" \
  --volume "${REPO_DIR}:/stella" \
  --volume "${VOLUME_PREFIX}-bun-${PINNED_BUN_VERSION}:/opt/bun:ro" \
  --volume "${VOLUME_PREFIX}-cargo:/cache/cargo" \
  --volume "${VOLUME_PREFIX}-rustup:/usr/local/rustup" \
  --volume "${VOLUME_PREFIX}-target:/cache/target" \
  --env CARGO_HOME=/cache/cargo \
  --env CARGO_TARGET_DIR=/cache/target \
  --env "PATH=/cache/cargo/bin:/opt/bun:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  --workdir /stella/packages/scan-engine \
  "${RUST_IMAGE}" \
  bash -c 'rustup target add wasm32-unknown-unknown && bash scripts/build-wasm.sh'
