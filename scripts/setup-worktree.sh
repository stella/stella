#!/usr/bin/env bash
# Bootstrap a fresh git worktree.
#
# A new `git worktree add` starts with an empty node_modules, so the native
# TypeScript compiler (tsrs, a quarantined dependency) is absent and package
# builds fail immediately with "Module not found tsrs/bin/tsrs". This installs root and
# documentation MCP dependencies, then initializes the submodule that
# `bun run verify` needs.
#
# Run once after creating a worktree:  bun run setup:worktree
set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ bun install (restores the TypeScript compiler so builds work here)"
bun install

echo "→ bun run setup:mcp (prepares the documentation server before startup)"
bun run setup:mcp

echo "→ git submodule update --init .ai/shared (needed by verify / sync-ai:check)"
git submodule update --init .ai/shared 2>/dev/null || \
  echo "  (skipped: submodule unavailable in this checkout)"

echo "✓ worktree ready — typecheck/lint/verify can now run here"
