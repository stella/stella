#!/usr/bin/env bash
set -euo pipefail

scope=${1:-}
shift || true

if [[ "$scope" != "core" && "$scope" != "landing" && "$scope" != "marketing" && "$scope" != "pr-core" ]]; then
  echo "usage: $0 <core|landing|marketing|pr-core> [changed-file ...]" >&2
  exit 2
fi

for file in "$@"; do
  # PR shards opt in only for their test tree; broad runtime coverage stays
  # at full depth. Widen this positive pattern when PR runner capacity allows.
  if [[ "$scope" == "pr-core" ]]; then
    case "$file" in
      apps/web/e2e/marketing/*|apps/web/e2e/playwright.marketing.config.ts)
        ;;
      apps/web/e2e/*)
        echo true
        exit 0
        ;;
    esac
    continue
  fi

  case "$file" in
    .github/actions/setup-e2e-stack/*|.github/actions/setup-production-e2e/*|.github/actions/build-e2e-web/*|.github/actions/setup-playwright/*|.github/actions/marketing-capture/*|.github/workflows/ci.yml|.github/workflows/marketing-screenshots.yml|scripts/detect-e2e-changes.sh|bun.lock|package.json|patches/*)
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
    # Whatever the captured product surfaces render: the web app, the fonts
    # and static assets it serves itself, the API that serves their data, the
    # shared UI and copy, the seed that builds the scenes, the capture suite
    # itself, and the committed PNGs.
    marketing:apps/web/src/*|marketing:apps/web/public/*|marketing:apps/web/e2e/marketing/*|marketing:apps/web/e2e/playwright.marketing.config.ts|marketing:apps/web/package.json|marketing:apps/api/src/*|marketing:apps/api/scripts/seed-*|marketing:packages/ui/*|marketing:packages/locales/*|marketing:apps/landing/public/media/products/*.png)
      echo true
      exit 0
      ;;
  esac
done

echo false
