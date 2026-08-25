#!/usr/bin/env bash
# Lint the custom-oxlint plugin regression fixtures under
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

# Plugin sources have to load under Node's ESM resolver, not only Bun's.
#
# The lint below runs them through `bun --bun`, which infers a missing file
# extension on a relative import. `node_modules/.bin/oxlint` is a Node shim and
# does not, so a plugin importing a sibling without its extension loads in one
# invocation and not the other. That asymmetry is expensive to meet in the
# wild: the whole plugin set fails at config-parse time, and the error names
# the offending import rather than whatever was being linted, which reads like
# a broken toolchain rather than a one-character omission.
#
# Lint target is irrelevant — plugins load while the config is parsed, so any
# file exercises it. The lint result is discarded on purpose; only the loader
# is under test here.
plugin_load_output=$(./node_modules/.bin/oxlint \
  .oxlint-plugins/physical-properties.ts 2>&1 || true)

if grep -qE "Failed to load JS plugin|ERR_MODULE_NOT_FOUND" \
  <<<"$plugin_load_output"; then
  echo "An oxlint plugin does not load under Node." >&2
  echo "Usual cause: a relative import missing its file extension." >&2
  echo "" >&2
  echo "$plugin_load_output" >&2
  exit 1
fi

bun test ./scripts/oxlint-safe-fixers.test.ts

exec bun --bun oxlint -c oxlint.config.ts \
  --report-unused-disable-directives-severity=error \
  --deny-warnings \
  --type-aware \
  .oxlint-plugins/__fixtures__
