#!/usr/bin/env bash
# A skill in .ai/local-skills/ with the name of a shared skill replaces it, so
# later changes to the shared skill never reach this repository on their own.
# .ai/local-skills/shared-bases.sha256 records, in `shasum -a 256` format, the
# shared SKILL.md each such override was reconciled with. This check fails when
# a recorded shared skill has changed since, until the override is reconciled
# and its recorded hash updated.
set -euo pipefail

cd "${1:-.}"

record=".ai/local-skills/shared-bases.sha256"
[ -f "$record" ] || exit 0

if [ ! -d ".ai/shared/skills" ]; then
  echo "check-local-skill-overrides: skipped, .ai/shared is not checked out." >&2
  exit 0
fi

errors=0
while read -r recorded shared_path || [ -n "${recorded:-}" ]; do
  [ -n "${recorded:-}" ] || continue
  shared_path="${shared_path#\*}"
  name="$(basename "$(dirname "$shared_path")")"

  if [ "$shared_path" != ".ai/shared/skills/$name/SKILL.md" ]; then
    echo "error: $record lists $shared_path; record shared skills as .ai/shared/skills/<name>/SKILL.md" >&2
    errors=$((errors + 1))
    continue
  fi
  if [ ! -f ".ai/local-skills/$name/SKILL.md" ]; then
    echo "error: $record lists $name, but .ai/local-skills/$name/SKILL.md does not exist; drop the line" >&2
    errors=$((errors + 1))
    continue
  fi
  if [ ! -f "$shared_path" ]; then
    echo "error: shared $name was removed: reconcile the local override .ai/local-skills/$name/SKILL.md and drop its line from $record" >&2
    errors=$((errors + 1))
    continue
  fi

  actual="$(shasum -a 256 "$shared_path" | cut -d ' ' -f 1)"
  if [ "$actual" != "$recorded" ]; then
    echo "error: shared $name changed: reconcile the local override .ai/local-skills/$name/SKILL.md" >&2
    echo "  then record the new base: shasum -a 256 $shared_path, replacing its line in $record" >&2
    errors=$((errors + 1))
  fi
done <"$record"

if [ "$errors" -gt 0 ]; then
  exit 1
fi
