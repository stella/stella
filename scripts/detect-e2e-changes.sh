#!/usr/bin/env bash
set -euo pipefail

scope=${1:-}
shift || true

if [[ "$scope" != "core" && "$scope" != "landing" ]]; then
  echo "usage: $0 <core|landing> [changed-file ...]" >&2
  exit 2
fi

for file in "$@"; do
  case "$file" in
    .github/actions/setup-playwright/*|.github/workflows/ci.yml|scripts/detect-e2e-changes.sh|bun.lock|package.json|patches/*)
      echo true
      exit 0
      ;;
  esac

  case "$scope:$file" in
    core:apps/web/e2e/marketing/*|core:apps/web/e2e/playwright.marketing.config.ts)
      ;;
    core:apps/api/*|core:apps/web/*|core:packages/*|core:docker-compose.yml)
      echo true
      exit 0
      ;;
    landing:apps/landing/*|landing:apps/web/package.json|landing:apps/web/e2e/marketing/landing-*.spec.ts|landing:apps/web/e2e/playwright.marketing.config.ts|landing:packages/ui/*|landing:packages/anonymize-*|landing:packages/locales/*)
      echo true
      exit 0
      ;;
  esac
done

echo false
