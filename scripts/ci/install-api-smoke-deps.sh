#!/usr/bin/env bash
set -eo pipefail
bun .workflow-tooling/scripts/ci-install.ts "$RUNNER_TEMP/bun-install/smoke.log" --frozen-lockfile --ignore-scripts --filter @stll/scripts
