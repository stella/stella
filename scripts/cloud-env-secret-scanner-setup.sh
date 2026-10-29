#!/usr/bin/env bash
# Optional hosted-environment setup. The hooks also provision their own scanner.
# Failures leave the environment usable; the hooks still refuse unscanned commits.
set -uo pipefail

skip() {
  echo "gitleaks NOT installed: $*" >&2
  exit 0
}

command -v bun >/dev/null 2>&1 || skip "Bun is required to provision the pinned scanner"
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)" || skip "cannot locate provisioner"
SCANNER="$(bun "$SCRIPT_DIR/gitleaks.ts")" || skip "provisioning failed"
[ -f "$SCANNER" ] && [ -x "$SCANNER" ] || skip "provisioner returned no executable"

if [ "$SCANNER" = /usr/local/bin/gitleaks ]; then
  echo "gitleaks already available at $SCANNER"
  exit 0
fi

if [ "$(id -u)" = 0 ]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  SUDO="sudo -n"
else
  skip "needs root or passwordless sudo to write /usr/local/bin"
fi

$SUDO install -d -m 755 /usr/local/bin || skip "cannot create /usr/local/bin"
$SUDO install -m 755 "$SCANNER" /usr/local/bin/gitleaks || skip "cannot write /usr/local/bin/gitleaks"
echo "gitleaks installed at /usr/local/bin/gitleaks"
