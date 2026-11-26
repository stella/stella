#!/usr/bin/env bash
set -euo pipefail
bun .workflow-tooling/scripts/ci-service-images.ts --build apps/api/Dockerfile -- --progress=plain --file apps/api/Dockerfile \
  --build-arg "STELLA_VERSION=$(tr -d '[:space:]' < VERSION)" \
  --build-arg "STELLA_COMMIT_SHA=$(git rev-parse HEAD)" \
  --tag stella-api-release:ci . 2>&1 | tee "$RUNNER_TEMP/api-image-build.log"
