#!/usr/bin/env bash
# Detect untyped update objects in API handlers.
#
# Handlers that build partial update objects should use
# `pickDefined()` from `lib/pick-defined.ts` instead of
# manually constructing `Record<string, unknown> = { ... }`.
# The helper returns `Partial<Pick<T, K>>`, catching typos at
# compile time and preventing extra body fields from leaking
# into Drizzle's `.set()` clause.
#
# This check targets variable declarations that assign an
# object literal to a `Record<string, unknown>` variable
# (the PATCH update builder anti-pattern). It intentionally
# ignores `Record<string, unknown>` in type annotations,
# function parameters, and other legitimate uses.
#
# Usage:
#   scripts/lint-untyped-updates.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SEARCH_PATH="$ROOT/apps/api/src/handlers"

# Match: `const/let foo: Record<string, unknown> = `
# Uses extended regex (ERE) for macOS + Linux compatibility.
PATTERN='(const|let) [a-zA-Z_][a-zA-Z0-9_]*: Record<string, (unknown|any)> ='

# Exclude files that legitimately use Record<string, unknown>
# as generic data containers (e.g. DOCX template rendering).
results=$(grep -rEn \
  --exclude-dir='docx' \
  "$PATTERN" "$SEARCH_PATH" 2>/dev/null || true)

if [[ -n "$results" ]]; then
  echo "$results"
  echo ""
  echo "ERROR: Found Record<string, unknown> variable assignments in handlers."
  echo ""
  echo "Use pickDefined() from lib/pick-defined.ts instead:"
  echo ""
  echo "  // before"
  echo "  const updates: Record<string, unknown> = {};"
  echo "  if (body.name !== undefined) updates.name = body.name;"
  echo ""
  echo "  // after"
  echo "  const updates = pickDefined(body, [\"name\"]);"
  exit 1
fi

echo "No untyped update objects found in handlers."
