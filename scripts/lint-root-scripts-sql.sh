#!/usr/bin/env bash
# Enforce the SQL bind-cast guard over root `scripts/`.
#
# `code-check` lints `apps` and `packages`; root `scripts/` is outside that
# target, so a repair or backfill script writing JSONB through a bare `::jsonb`
# cast would silently double-encode the values it persists. Those scripts write
# to the same tables the app reads, so the guard has to reach them.
#
# Only `no-bare-jsonb-cast` runs here (`-A all` switches every other rule off).
# Bringing root scripts under the full ruleset is a separate cleanup; this keeps
# the correctness guard in place without importing that backlog.
set -euo pipefail

exec bun --bun oxlint -c oxlint.config.ts \
  -A all \
  -D no-bare-jsonb-cast/no-bare-jsonb-cast \
  --deny-warnings \
  scripts
