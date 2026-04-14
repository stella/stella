#!/usr/bin/env bash
set -euo pipefail

exec bun packages/scripts/src/dev-runner.ts "$@"
