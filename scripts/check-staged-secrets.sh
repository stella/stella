#!/usr/bin/env bash
set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "error: gitleaks is required for pre-commit secret scanning." >&2
  echo "Install it from https://github.com/gitleaks/gitleaks/releases" >&2
  echo "  macOS (Homebrew): brew install gitleaks" >&2
  echo "  Other platforms: use the releases page above" >&2
  exit 1
fi

exec gitleaks git --staged --redact --no-banner --no-color .
