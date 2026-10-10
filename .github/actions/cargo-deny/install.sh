#!/usr/bin/env bash
set -euo pipefail

if [[ "$RUNNER_OS" != "macOS" || "$RUNNER_ARCH" != "ARM64" ]]; then
  echo "::error::cargo-deny is installed here for macOS ARM64 only, got ${RUNNER_OS} ${RUNNER_ARCH}"
  exit 1
fi
if [[ ! "$CARGO_DENY_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "::error::cargo-deny requires a SHA-256 pin"
  exit 1
fi

fetch() {
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
    --retry-connrefused --connect-timeout 20 "$1" -o "$2"
}

name="cargo-deny-${CARGO_DENY_VERSION}-aarch64-apple-darwin"
release="${CARGO_DENY_RELEASE_URL:-https://github.com/EmbarkStudios/cargo-deny/releases/download/${CARGO_DENY_VERSION}}"
bin_dir="${HOME}/.cargo-deny/bin"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Only transport errors permit the source build. A hash mismatch always fails.
if ! fetch "${release}/${name}.tar.gz" "${work}/archive.tar.gz"; then
  echo "::warning::cargo-deny release download failed; building ${CARGO_DENY_VERSION} from source"
  cargo install cargo-deny --version "$CARGO_DENY_VERSION" --locked --root "${HOME}/.cargo-deny"
else
  actual="$(shasum -a 256 "${work}/archive.tar.gz" | cut -d' ' -f1)"
  if [[ "$actual" != "$CARGO_DENY_SHA256" ]]; then
    echo "::error::cargo-deny archive hash mismatch for ${CARGO_DENY_VERSION}: expected ${CARGO_DENY_SHA256}, got ${actual}"
    exit 1
  fi
  tar -xzf "${work}/archive.tar.gz" -C "$work"
  mkdir -p "$bin_dir"
  mv "${work}/${name}/cargo-deny" "${bin_dir}/cargo-deny"
  chmod +x "${bin_dir}/cargo-deny"
fi

reported="$("${bin_dir}/cargo-deny" --version)"
if [[ "$reported" != "cargo-deny ${CARGO_DENY_VERSION}" ]]; then
  echo "::error::cargo-deny reports '${reported}', expected ${CARGO_DENY_VERSION}"
  exit 1
fi
echo "$reported"
echo "$bin_dir" >> "$GITHUB_PATH"
