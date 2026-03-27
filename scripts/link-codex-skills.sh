#!/usr/bin/env bash
set -euo pipefail

if [[ ! -d ".ai/shared" ]] || [[ -z "$(ls -A .ai/shared 2>/dev/null)" ]]; then
  echo "error: .ai/shared submodule is not initialized." >&2
  echo "Run: git submodule update --init" >&2
  exit 1
fi

if [[ ! -f ".ai/shared/scripts/link-codex-skills.sh" ]]; then
  echo "error: .ai/shared/scripts/link-codex-skills.sh not found." >&2
  echo "The submodule may be pinned to an incompatible commit." >&2
  exit 1
fi

bash .ai/shared/scripts/link-codex-skills.sh .
