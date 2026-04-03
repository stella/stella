#!/usr/bin/env bash
# Verify that every generated skill file has a source.
# .claude/commands/*.md and .agents/skills/*/SKILL.md must
# originate from .ai/local-skills/ or .ai/shared/skills/.
set -euo pipefail

if [ ! -d ".ai/shared/skills" ]; then
  echo "warning: .ai/shared submodule not initialized; skipping skill source check" >&2
  echo "  fix: git submodule update --init" >&2
  exit 0
fi

errors=0

for cmd in .claude/commands/*.md; do
  [ -f "$cmd" ] || continue
  name=$(basename "$cmd" .md)

  if [ ! -f ".ai/local-skills/$name/SKILL.md" ] \
    && [ ! -f ".ai/shared/skills/$name/SKILL.md" ]; then
    echo "error: $cmd has no source in .ai/local-skills/ or .ai/shared/skills/" >&2
    echo "  fix: mkdir -p .ai/local-skills/$name && cp $cmd .ai/local-skills/$name/SKILL.md && bun run sync-ai" >&2
    echo "" >&2
    errors=$((errors + 1))
  fi
done

for skill in .agents/skills/*/SKILL.md; do
  [ -f "$skill" ] || continue
  name=$(basename "$(dirname "$skill")")

  if [ ! -f ".ai/local-skills/$name/SKILL.md" ] \
    && [ ! -f ".ai/shared/skills/$name/SKILL.md" ]; then
    echo "error: $skill has no source in .ai/local-skills/ or .ai/shared/skills/" >&2
    echo "  fix: mkdir -p .ai/local-skills/$name && cp $skill .ai/local-skills/$name/SKILL.md && bun run sync-ai" >&2
    echo "" >&2
    errors=$((errors + 1))
  fi
done

if [ "$errors" -gt 0 ]; then
  echo "Found $errors orphaned skill file(s). Run the fix commands above, then stage the new files." >&2
  exit 1
fi
