#!/usr/bin/env bash
# Check the local oxlint rules under `.oxlint-plugins`: lint the rule sources
# and their tests, run the tests, and lint the regression fixtures under
# `.oxlint-plugins/__fixtures__`. Each fixture relies on
# `oxlint-disable-next-line` directives that go unused when the
# associated custom rule regresses, so we run oxlint with
# `--report-unused-disable-directives-severity=error` here.
#
# Arguments forwarded by callers (e.g. `--affected` from
# `bun run lint -- --affected` in CI) are intentionally swallowed:
# the fixtures are a fixed, tiny target that does not participate
# in turbo's affected-packages graph.
set -euo pipefail

bun scripts/check-swallowed-item-error-ledger.ts --self-test
bun scripts/check-swallowed-item-error-ledger.ts
bun scripts/check-test-state-baseline.ts --base "${RATCHET_BASE_REF:-origin/main}"
bun scripts/check-concurrency-exceptions.ts
bun test ./scripts/check-concurrency-exceptions.test.ts
bun scripts/check-contract-domain-ledger.ts --self-test
bun scripts/check-contract-domain-ledger.ts
bun scripts/calendar-day-ledger.ts --self-test
bun scripts/calendar-day-ledger.ts
bun scripts/fill-diagnostics-ledger.ts --self-test

bash scripts/check-oxlint-node-loader.test.sh
bash scripts/check-oxlint-node-loader.sh

# The rule sources sit outside every Turbo workspace, so no workspace `lint`
# reaches them. The fixtures are excluded: they violate rules on purpose and
# are linted on their own below. The file list comes from git for the reason
# `lint-root-scripts.sh` gives: a directory target can silently match nothing.
plugin_sources=()
while IFS= read -r file; do
  plugin_sources+=("${file}")
done < <(git ls-files '.oxlint-plugins/*.ts' \
  ':(exclude).oxlint-plugins/__fixtures__/**')

if [[ ${#plugin_sources[@]} -eq 0 ]]; then
  echo "lint-oxlint-fixtures: no rule sources found; refusing to pass vacuously" >&2
  exit 1
fi

bun --bun oxlint -c oxlint.config.ts \
  --report-unused-disable-directives-severity=error \
  --type-aware \
  --type-check \
  "${plugin_sources[@]}"

bun test ./scripts/oxlint-safe-fixers.test.ts
bun test ./scripts/oxlint-typebox-unsafe.test.ts
bun test ./scripts/oxlint-additional-guards.test.ts
bun test ./scripts/check-oxlint-plugin-registry.test.ts
bun test ./scripts/check-oxlint-fixture-counts.test.ts
# One isolated worker per core: the rule test files share no state, and run
# serially they dominate this check.
bun test --parallel ./.oxlint-plugins/__tests__

# Directive usage proves each expected hit fires at least once; the count
# check then proves each fires exactly as often as its fixture line claims.
bun scripts/check-oxlint-fixture-counts.ts

exec bun --bun oxlint -c oxlint.config.ts \
  --report-unused-disable-directives-severity=error \
  --type-aware \
  .oxlint-plugins/__fixtures__
