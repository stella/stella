#!/usr/bin/env bash
# Setup script for hosted agent environments: installs the pinned gitleaks as
# /usr/local/bin/gitleaks so the repository's commit hooks can run there.
#
# It never fails the environment. On any problem it prints
# "gitleaks NOT installed: <reason>", installs nothing and exits 0, so every
# session on a shared environment still starts. Commits stay protected because
# the pre-commit hook refuses to commit without gitleaks.
#
# VERSION must equal stll-toolchain.json cloud.tools.gitleaks, and the SHA256
# values must equal the release checksums pinned in .agents/cloud-setup.sh
# (cloud-env-secret-scanner-setup.test.ts enforces both).
set -uo pipefail

VERSION=8.30.1
SHA256_X64=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
SHA256_ARM64=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080

SCRATCH=""
skip() {
  echo "gitleaks NOT installed: $*" >&2
  [ -n "$SCRATCH" ] && rm -rf -- "$SCRATCH"
  exit 0
}

case "$(uname -m)" in
  x86_64 | amd64) arch=x64; SHA256="$SHA256_X64" ;;
  aarch64 | arm64) arch=arm64; SHA256="$SHA256_ARM64" ;;
  *) skip "unsupported CPU $(uname -m)" ;;
esac

if [ "$(id -u)" = 0 ]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  SUDO="sudo -n"
else
  skip "needs root or passwordless sudo to write /usr/local/bin"
fi

if command -v gitleaks >/dev/null 2>&1 && [ "$(gitleaks version 2>/dev/null)" = "$VERSION" ]; then
  echo "gitleaks $VERSION already on PATH at $(command -v gitleaks)"
  exit 0
fi

archive="gitleaks_${VERSION}_linux_${arch}.tar.gz"
URL="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${archive}"
SCRATCH="$(mktemp -d)" || skip "no temporary directory"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL --retry 3 --max-time 120 -o "$SCRATCH/$archive" "$URL" || skip "download failed: $URL"
elif command -v wget >/dev/null 2>&1; then
  wget -q --tries=3 --timeout=120 -O "$SCRATCH/$archive" "$URL" || skip "download failed: $URL"
else
  skip "neither curl nor wget is installed"
fi

ACTUAL="$(sha256sum "$SCRATCH/$archive" | cut -d' ' -f1)"
[ "$ACTUAL" = "$SHA256" ] || skip "checksum mismatch for $archive: expected $SHA256, got $ACTUAL"

tar -xzf "$SCRATCH/$archive" -C "$SCRATCH" gitleaks || skip "archive has no gitleaks binary"
$SUDO install -d -m 755 /usr/local/bin || skip "cannot create /usr/local/bin"
$SUDO install -m 755 "$SCRATCH/gitleaks" /usr/local/bin/gitleaks || skip "cannot write /usr/local/bin/gitleaks"
rm -rf -- "$SCRATCH"
SCRATCH=""

hash -r
installed="$(command -v gitleaks || true)"
if [ "$installed" != /usr/local/bin/gitleaks ]; then
  echo "gitleaks WARNING: installed at /usr/local/bin/gitleaks, but PATH finds '${installed:-nothing}' first" >&2
fi
REPORTED="$(/usr/local/bin/gitleaks version 2>&1 || true)"
if [ "$REPORTED" != "$VERSION" ]; then
  $SUDO rm -f /usr/local/bin/gitleaks
  skip "installed binary reported '$REPORTED', expected $VERSION (removed again)"
fi
echo "gitleaks $VERSION installed at /usr/local/bin/gitleaks ($arch, sha256 $SHA256)"
