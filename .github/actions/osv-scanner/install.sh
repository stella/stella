#!/usr/bin/env bash
set -euo pipefail

if [[ "$RUNNER_OS" != "Linux" || "$RUNNER_ARCH" != "X64" ]]; then
  echo "::error::OSV-Scanner is installed here for Linux X64 only, got ${RUNNER_OS} ${RUNNER_ARCH}"
  exit 1
fi
if [[ ! "$OSV_SCANNER_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "::error::OSV-Scanner requires a SHA-256 pin"
  exit 1
fi

fetch() {
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
    --retry-connrefused --connect-timeout 20 "$1" -o "$2"
}

primary="${OSV_SCANNER_PRIMARY_RELEASE_URL:-https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_RELEASE_VERSION}}"
mirror="${OSV_SCANNER_MIRROR_RELEASE_URL:-https://github.com/stella/.github/releases/download/mirror-osv-scanner-v${OSV_SCANNER_RELEASE_VERSION}}"
bin="${HOME}/.osv-scanner/bin/osv-scanner"
download="$(mktemp)"
trap 'rm -f "$download"' EXIT

if [[ -f "$bin" ]]; then
  candidate="$bin"
else
  mkdir -p "$(dirname "$bin")"
  # Only transport errors permit fallback. A hash mismatch always fails.
  if ! fetch "${primary}/osv-scanner_linux_amd64" "$download"; then
    echo "::warning::OSV-Scanner primary download failed; trying pinned mirror"
    fetch "${mirror}/osv-scanner_linux_amd64" "$download"
  fi
  candidate="$download"
fi

# Cache restores have the same trust boundary as downloads.
actual="$(sha256sum "$candidate" | cut -d' ' -f1)"
if [[ "$actual" != "$OSV_SCANNER_SHA256" ]]; then
  echo "::error::OSV-Scanner binary hash mismatch for ${OSV_SCANNER_RELEASE_VERSION}: expected ${OSV_SCANNER_SHA256}, got ${actual}"
  exit 1
fi
if [[ "$candidate" != "$bin" ]]; then
  mv "$candidate" "$bin"
fi
chmod +x "$bin"
"$bin" --version
echo "$(dirname "$bin")" >> "$GITHUB_PATH"
