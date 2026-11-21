#!/usr/bin/env bash
set -euo pipefail

probe="$(mktemp -u packages/sha256/src/typecheck-command-probe.XXXXXXXX).ts"
# Reserve the selected path atomically before cleanup can own it.
if ! (set -o noclobber; printf 'export const typecheckCommandProbe: number = "wrong";\n' > "$probe"); then
  echo "The selected typecheck probe path already exists or cannot be created."
  exit 1
fi
trap 'rm -f "$probe"' EXIT
if bun run typecheck --filter=@stll/sha256 --only --force > "$RUNNER_TEMP/typecheck-command-probe.log" 2>&1; then
  cat "$RUNNER_TEMP/typecheck-command-probe.log"
  echo "The typecheck command accepted a seeded type error."
  exit 1
fi
cat "$RUNNER_TEMP/typecheck-command-probe.log"
grep -Fq "${probe##*/}" "$RUNNER_TEMP/typecheck-command-probe.log"
grep -q '2322' "$RUNNER_TEMP/typecheck-command-probe.log"
rm "$probe"
bun run typecheck --filter=@stll/sha256 --only --force
