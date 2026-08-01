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
    core:apps/api/*|core:apps/web/*|core:packages/*|core:docker-compose.yml)
      echo true
      exit 0
      ;;
    marketing:apps/web/e2e/marketing/*|marketing:apps/web/e2e/playwright.marketing.config.ts|marketing:apps/api/scripts/seed-dev.ts|marketing:apps/api/scripts/seed-templates.ts|marketing:apps/api/scripts/seed-test-user.ts|marketing:apps/web/src/components/*|marketing:apps/web/src/features/case-law/*|marketing:apps/web/src/features/chat/*|marketing:apps/web/src/i18n/*|marketing:apps/web/src/lib/knowledge/*|marketing:apps/web/src/routes/_protected.chat*|marketing:apps/web/src/routes/_protected.knowledge*|marketing:apps/web/src/routes/_protected.workspaces*|marketing:apps/web/src/routes/law*|marketing:apps/web/src/routes/__root.tsx|marketing:apps/web/src/fonts.css|marketing:apps/web/public/dark-mode-init.js|marketing:packages/docx-utils/*|marketing:packages/locales/*|marketing:packages/ui/*|marketing:apps/landing/public/media/products/*.png)
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
