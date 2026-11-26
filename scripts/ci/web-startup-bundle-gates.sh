#!/usr/bin/env bash
set -eo pipefail
bun scripts/bundle-baseline.ts --self-test
bun --preload ./scripts/offline-network-preload.ts scripts/bundle-baseline.ts --check
