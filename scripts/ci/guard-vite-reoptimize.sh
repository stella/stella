#!/usr/bin/env bash
set -eo pipefail
if grep -q "optimized dependencies changed. reloading" /tmp/web.log; then
  echo "::error::Vite re-optimized dependencies mid-session and forced a reload. Add the lazy/runtime dependency named below to optimizeDeps.include in apps/web/vite.config.ts."
  grep -nE "new dependencies optimized|optimized dependencies changed" /tmp/web.log || true
  exit 1
fi
echo "No mid-session dep re-optimize detected."
