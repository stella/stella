#!/usr/bin/env bash
# Scan the commits a push would publish for secrets. Runs from the pre-push
# hook; everything else is validated in CI.
set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "error: gitleaks is required for pre-push secret scanning." >&2
  echo "Install it from https://github.com/gitleaks/gitleaks/releases" >&2
  echo "  macOS (Homebrew): brew install gitleaks" >&2
  echo "  Other platforms: use the releases page above" >&2
  exit 1
fi

# Commits not yet on the default branch. A stale origin/main only widens the
# range, so the scan still covers every commit the push carries.
if base="$(git merge-base origin/main HEAD 2>/dev/null)"; then
  range="${base}..HEAD"
else
  range="HEAD"
fi

exec gitleaks git --redact --no-banner --no-color --log-opts="${range}" .
