#!/usr/bin/env bash
set -euo pipefail

# The asset name below is platform-specific, so refuse to guess rather
# than install a binary for the wrong platform.
if [[ "$RUNNER_OS" != "Linux" || "$RUNNER_ARCH" != "X64" ]]; then
  echo "::error::Safe Chain is installed here for Linux X64 only," \
       "got ${RUNNER_OS} ${RUNNER_ARCH}"
  exit 1
fi

fetch() {
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
    --retry-connrefused --connect-timeout 20 "$1" -o "$2"
}

primary="${SAFE_CHAIN_PRIMARY_RELEASE_URL:-https://github.com/AikidoSec/safe-chain/releases/download/${SAFE_CHAIN_RELEASE_VERSION}}"
mirror="${SAFE_CHAIN_MIRROR_RELEASE_URL:-https://github.com/stella/.github/releases/download/mirror-safe-chain-${SAFE_CHAIN_RELEASE_VERSION}}"

# A successful response still has to pass the hash check below. Fall back only
# on transport failure, never on a hash mismatch from either source.
fetch_asset() {
  if fetch "${primary}/$1" "$2"; then
    return 0
  fi
  echo "::warning::Safe Chain primary download failed for $1; trying pinned mirror"
  fetch "${mirror}/$1" "$2"
}

installer="$(mktemp)"
binary_download="$(mktemp)"
trap 'rm -f "$installer" "$binary_download"' EXIT

if [[ ! "${SAFE_CHAIN_BINARY_SHA256:-}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "::error::No pinned Safe Chain binary hash for ${SAFE_CHAIN_RELEASE_VERSION};" \
       "refusing to install an unverified binary"
  exit 1
fi
expected_binary="$SAFE_CHAIN_BINARY_SHA256"

# The binary is pinned on its own, so a cached binary installs without any
# download from GitHub releases. Only a cold cache fetches the installer,
# which is read, not run (its own binary download has no retry), and must
# carry the same binary hash as the pin.
bin="${HOME}/.safe-chain/bin/safe-chain"
if [[ ! -f "$bin" ]]; then
  fetch_asset install-safe-chain.sh "$installer"

  actual="$(sha256sum "$installer" | cut -d' ' -f1)"
  if [[ "$actual" != "$SAFE_CHAIN_SHA256" ]]; then
    echo "::error::Safe Chain installer hash mismatch for ${SAFE_CHAIN_RELEASE_VERSION}:" \
         "expected ${SAFE_CHAIN_SHA256}, got ${actual}"
    exit 1
  fi

  # Upstream skips verification when that hash is empty; we never do.
  installer_binary="$(sed -nE 's/^SHA256_LINUXSTATIC_X64="([0-9a-f]{64})"$/\1/p' "$installer")"
  installer_binary="${installer_binary%%$'\n'*}"
  if [[ "$installer_binary" != "$expected_binary" ]]; then
    echo "::error::Safe Chain ${SAFE_CHAIN_RELEASE_VERSION} installer pins binary" \
         "'${installer_binary}', not the pinned ${expected_binary}"
    exit 1
  fi

  mkdir -p "$(dirname "$bin")"
  fetch_asset safe-chain-linuxstatic-x64 "$binary_download"
  candidate="$binary_download"
else
  candidate="$bin"
fi

# A restored cache is untrusted input, so verify on a hit too.
actual="$(sha256sum "$candidate" | cut -d' ' -f1)"
if [[ "$actual" != "$expected_binary" ]]; then
  echo "::error::Safe Chain binary hash mismatch for ${SAFE_CHAIN_RELEASE_VERSION}:" \
       "expected ${expected_binary}, got ${actual}"
  exit 1
fi
if [[ "$candidate" != "$bin" ]]; then
  mv "$candidate" "$bin"
fi
chmod +x "$bin"

# setup-ci installs PATH shims instead of shell aliases, so
# non-interactive `run:` steps pick them up, and writes GITHUB_PATH.
"$bin" setup-ci

# Safe Chain also defaults to a 48-hour package-age filter. Stella's
# 5-day gate and its reviewed exclusions live in bunfig.toml, so keep
# this independent signal limited to malware in every later step.
echo "SAFE_CHAIN_MINIMUM_PACKAGE_AGE_HOURS=0" >> "$GITHUB_ENV"
