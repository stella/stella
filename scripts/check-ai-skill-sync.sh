#!/usr/bin/env bash
set -uo pipefail

repo_root="${1:-.}"
base_ref="${2:-origin/main}"
sync_script="$repo_root/.ai/shared/scripts/sync-ai-skills.sh"

if [[ -f "$sync_script" && -d "$repo_root/.ai/shared/skills" ]]; then
  exec bash "$sync_script" --check "$repo_root"
fi

if ! comparison_base="$(git -C "$repo_root" merge-base "$base_ref" HEAD)"; then
  echo "error: cannot determine instruction changes against $base_ref; initialize .ai/shared before checking sync." >&2
  exit 1
fi

instruction_paths=(
  .ai .agents/skills .claude/skills .claude/commands
  .gitmodules .coderabbit.yaml
  scripts/check-ai-skill-sync.sh scripts/check-ai-skill-sources.sh
  ':(glob)**/AGENTS.md' ':(glob)**/CLAUDE.md' ':(glob)**/GEMINI.md'
)

# Inspect branch, index, and working-tree changes separately: an unstaged revert
# must not hide a staged instruction change that the next commit would publish.
if ! changed_instructions="$(
  git -C "$repo_root" diff --name-only --no-renames "$comparison_base" HEAD -- "${instruction_paths[@]}" &&
    git -C "$repo_root" diff --name-only --no-renames HEAD -- "${instruction_paths[@]}" &&
    git -C "$repo_root" diff --name-only --no-renames --cached -- "${instruction_paths[@]}" &&
    git -C "$repo_root" ls-files --others --exclude-standard -- "${instruction_paths[@]}"
)"; then
  echo "error: cannot inspect instruction changes; initialize .ai/shared before checking sync." >&2
  exit 1
fi

if [[ -n "$changed_instructions" ]]; then
  echo "error: instruction files changed but .ai/shared is not initialized." >&2
  echo "Run: git submodule update --init .ai/shared" >&2
  exit 1
fi

echo "SKIPPED: AI skill sync; .ai/shared is not initialized and no instruction files changed. CI still checks sync."
# Local verification reserves exit 77 for a check that deliberately did not run.
exit 77
