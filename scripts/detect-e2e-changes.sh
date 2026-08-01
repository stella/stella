#!/usr/bin/env bash
set -euo pipefail

scope=${1:-}
shift || true

if [[ "$scope" != "core" && "$scope" != "marketing" && "$scope" != "landing" ]]; then
  echo "usage: $0 <core|marketing|landing> [changed-file ...]" >&2
  exit 2
fi

for file in "$@"; do
  case "$file" in
    .github/workflows/ci.yml|scripts/detect-e2e-changes.sh|bun.lock|package.json|patches/*)
      echo true
      exit 0
      ;;
  esac

  case "$scope:$file" in
    core:apps/web/e2e/marketing/*|core:apps/web/e2e/playwright.marketing.config.ts)
      ;;
    marketing:apps/api/src/*.test.*|marketing:apps/api/src/*.spec.*|marketing:apps/web/src/*.test.*|marketing:apps/web/src/*.spec.*|marketing:packages/*.test.*|marketing:packages/*.spec.*)
      ;;
    core:apps/api/*|core:apps/web/*|core:packages/*|core:docker-compose.yml)
      echo true
      exit 0
      ;;
    marketing:apps/web/e2e/marketing/*|marketing:apps/web/e2e/playwright.marketing.config.ts|marketing:apps/api/src/*|marketing:apps/api/scripts/seed-dev.ts|marketing:apps/api/scripts/seed-templates.ts|marketing:apps/api/scripts/seed-test-user.ts|marketing:apps/api/.env.example|marketing:apps/api/package.json|marketing:apps/web/src/*|marketing:apps/web/public/*|marketing:apps/web/.env.example|marketing:apps/web/index.html|marketing:apps/web/package.json|marketing:apps/web/vite.config.*|marketing:packages/*|marketing:apps/landing/public/media/products/*.png)
      echo true
      exit 0
      ;;
    landing:apps/landing/*|landing:packages/ui/*|landing:packages/anonymize-*|landing:packages/locales/*)
      echo true
      exit 0
      ;;
  esac
done

echo false
