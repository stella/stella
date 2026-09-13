#!/usr/bin/env bash
# Verify that every generated skill file has a source.
# .claude/skills/*/SKILL.md and .agents/skills/*/SKILL.md must
# originate from .ai/local-skills/ or .ai/shared/skills/.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${1:-.}"

if [[ ! -d ".ai/shared/skills" || ! -f ".ai/shared/scripts/sync-ai-skills.sh" ]]; then
  if bash "$script_dir/check-ai-skill-sync.sh" . "${2:-origin/main}"; then
    exit 0
  else
    check_status=$?
  fi
  # The hook may proceed after an explicit skip for unrelated changes.
  if [[ "$check_status" -eq 77 ]]; then
    exit 0
  fi
  exit "$check_status"
fi

errors=0

for skill in .claude/skills/*/SKILL.md .agents/skills/*/SKILL.md; do
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
