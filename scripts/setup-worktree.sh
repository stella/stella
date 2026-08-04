#!/usr/bin/env bash
# Bootstrap a fresh git worktree.
#
# A new `git worktree add` starts with an empty node_modules, so the native
# TypeScript compiler binary (@typescript/native, a quarantined dependency) is
# absent and `bun run typecheck` fails immediately with
# "Module not found @typescript/native/bin/tsc". This installs deps (which
# restores the binary in ~10 s without changing bun.lock) and inits the
# submodule that `bun run verify` needs.
#
# Run once after creating a worktree:  bun run setup:worktree
set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ bun install (restores @typescript/native so typecheck works here)"
bun install

echo "→ git submodule update --init .ai/shared (needed by verify / sync-ai:check)"
git submodule update --init .ai/shared 2>/dev/null || \
  echo "  (skipped: submodule unavailable in this checkout)"

echo "✓ worktree ready — typecheck/lint/verify can now run here"
