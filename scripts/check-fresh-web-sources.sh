#!/usr/bin/env bash
set -euo pipefail

export_dir=$(mktemp -d "${RUNNER_TEMP:?}/fresh-web-XXXXXX")
trap 'rm -rf "$export_dir"' EXIT
git ls-files --stage > "$export_dir/tracked-index"
git archive HEAD | tar -x -C "$export_dir"
cd "$export_dir"
test ! -e apps/web/src/routeTree.gen.ts
test ! -e apps/web/src/generated/api-routes.gen.ts
# Metadata lets manifest tests check ignores, while all sources come from archive.
git init --quiet
git update-index --index-info < "$export_dir/tracked-index"
bun ci --ignore-scripts
cp apps/web/.env.example apps/web/.env
bun run typegen
bun --cwd apps/web run typecheck
test -s apps/web/src/routeTree.gen.ts
rm apps/web/src/routeTree.gen.ts
bun --cwd apps/web run test scripts/generate-route-tree.test.ts scripts/network-baseline-route-tree.test.ts src/public-crawl-policy.test.ts
test -s apps/web/src/routeTree.gen.ts
bun test scripts/generated-files.test.ts scripts/code-check-affected.test.ts
bun --cwd packages/scripts run test src/web-generation-cache.test.ts
bun --cwd apps/web run generate:route-tree --check

# The injected nondeterminism test must fail when the byte comparison is removed.
generator=apps/web/scripts/generate-route-tree.ts
cp "$generator" "$export_dir/generator-before-mutation.ts"
python3 - <<'PY_MUTATION'
from pathlib import Path
p = Path("apps/web/scripts/generate-route-tree.ts")
s = p.read_text()
needle = "if (!actual.equals(expected))"
assert s.count(needle) == 1
p.write_text(s.replace(needle, "if (false)"))
PY_MUTATION
status=0
bun --cwd apps/web run test scripts/generate-route-tree.test.ts -t 'rejects injected nondeterminism' > "$export_dir/mutation.log" 2>&1 || status=$?
cp "$export_dir/generator-before-mutation.ts" "$generator"
cat "$export_dir/mutation.log"
test "$status" -ne 0
grep -q 'rejects injected nondeterminism' "$export_dir/mutation.log"
grep -Eq 'promise.*resolv|[1-9][0-9]* fail' "$export_dir/mutation.log"
rm apps/web/src/routeTree.gen.ts
bun --cwd apps/web run build
test -s apps/web/src/routeTree.gen.ts
test -s apps/web/dist/runtime.js
printf 'Fresh export: web typecheck, focused tests, build, cache restoration and mutation proof passed.\n' >> "$GITHUB_STEP_SUMMARY"
