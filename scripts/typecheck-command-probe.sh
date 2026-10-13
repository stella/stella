#!/usr/bin/env bash
set -euo pipefail

probe=packages/sha256/src/typecheck-command-probe.ts
trap 'rm -f "$probe"' EXIT
printf 'export const typecheckCommandProbe: number = "wrong";\n' > "$probe"
if bun run typecheck --filter=@stll/sha256 --only --force > "$RUNNER_TEMP/typecheck-command-probe.log" 2>&1; then
  cat "$RUNNER_TEMP/typecheck-command-probe.log"
  echo "The typecheck command accepted a seeded type error."
  exit 1
fi
cat "$RUNNER_TEMP/typecheck-command-probe.log"
grep -q 'typecheck-command-probe.ts' "$RUNNER_TEMP/typecheck-command-probe.log"
grep -q '2322' "$RUNNER_TEMP/typecheck-command-probe.log"
rm "$probe"
bun run typecheck --filter=@stll/sha256 --only --force
