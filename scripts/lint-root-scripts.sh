#!/usr/bin/env bash
# Lint root `scripts/` with the full Oxlint ruleset.
#
# `turbo run lint` only reaches workspaces and `code-check-affected.ts` only
# lints affected workspace targets, so root `scripts/` — which holds the repo's
# own CI guards (ratchet, rc-bailouts, typecheck-baseline, lint-changed) — sits
# outside every target. This closes that gap.
#
# The TypeScript driver owns the file selection and exact Oxlint invocation
# shared with code-check:affected. It enumerates tracked files rather than
# passing the `scripts` directory because Oxlint's ignore walker can silently
# match zero files for a directory target in a linked worktree.
#
# This run subsumes the former SQL-only guard: `no-bare-jsonb-cast` is "error"
# in the base config, so a repair or backfill script writing JSONB through a
# bare `::jsonb` cast (which double-encodes the value Postgres stores) is still
# caught here.
set -euo pipefail

exec bun scripts/lint-root-scripts.ts
