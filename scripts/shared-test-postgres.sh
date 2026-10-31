#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
exec bun "$repo/apps/api/scripts/shared-test-postgres.ts" "$@"
