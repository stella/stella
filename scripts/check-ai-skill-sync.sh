#!/usr/bin/env bash
set -uo pipefail

repo_root="${1:-.}"
sync_script="$repo_root/.ai/shared/scripts/sync-ai-skills.sh"

if [[ ! -f "$sync_script" ]]; then
  echo ".ai/shared is not initialized; skipping the local AI skill sync check. CI still checks it."
  exit 0
fi

bash "$sync_script" --check "$repo_root"
