#!/usr/bin/env bash
set -eo pipefail
echo 'contexts<<CI_IMAGE_CONTEXTS' >> "$GITHUB_OUTPUT"
bun .workflow-tooling/scripts/ci-service-images.ts --pull apps/legal-atlas-runner/Dockerfile
bun .workflow-tooling/scripts/ci-service-images.ts --build-contexts apps/legal-atlas-runner/Dockerfile >> "$GITHUB_OUTPUT"
echo 'CI_IMAGE_CONTEXTS' >> "$GITHUB_OUTPUT"
rm -rf .workflow-tooling
