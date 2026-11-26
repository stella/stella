#!/usr/bin/env bash
set -eo pipefail
bash "$GITHUB_WORKSPACE/.github/actions/setup-playwright/run-in-image.sh" bun --filter @stll/web test:e2e:collab -- --project chromium
