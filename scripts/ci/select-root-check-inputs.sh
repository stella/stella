#!/usr/bin/env bash
set -eo pipefail
if ! timeout --kill-after=10s 120s bun scripts/ci-root-checks.ts; then
  echo "::warning::Root check planning unavailable; retaining all checks."
fi
