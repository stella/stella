#!/usr/bin/env bash
set -eo pipefail
# A changed test repeats in this shard, which never generates the API
# runtime; tests that bundle or import the API read it like their own
# jobs do.
bun --cwd=packages/cli run codegen:runtime
bun --cwd=apps/api run generate:capability-runtime
printf '%s\n' "$CHANGED_FILES" > "$RUNNER_TEMP/changed-files.json"
CHANGED_FILES_PATH="$RUNNER_TEMP/changed-files.json" bun scripts/flake-gate.ts --blocking
