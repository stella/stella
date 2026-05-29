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

exec bun --bun oxlint -c oxlint.config.ts \
  --report-unused-disable-directives-severity=error \
  --deny-warnings \
  --type-aware \
  .oxlint-plugins/__fixtures__
