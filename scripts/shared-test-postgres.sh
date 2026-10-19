#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
exec bun "$repo/packages/scripts/src/shared-test-postgres.ts" "$@"
