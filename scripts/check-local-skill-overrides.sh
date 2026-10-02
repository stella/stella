#!/usr/bin/env bash
# A skill in .ai/local-skills/ with the name of a shared skill replaces it, so
# later changes to the shared skill never reach this repository on their own.
# .ai/local-skills/shared-bases.sha256 records, in `shasum -a 256` format, the
# shared SKILL.md each such override was reconciled with: exactly one line per
# override. This check fails when an override has no recorded base, when a
# line names no override, or when a recorded shared skill has changed since,
# until the override is reconciled and its recorded base updated.
set -euo pipefail

cd "${1:-.}"

record=".ai/local-skills/shared-bases.sha256"

if [ ! -d ".ai/shared/skills" ]; then
  echo "check-local-skill-overrides: skipped, .ai/shared is not checked out." >&2
  exit 0
fi

overrides=()
for local_skill in .ai/local-skills/*/SKILL.md; do
  [ -f "$local_skill" ] || continue
  name="$(basename "$(dirname "$local_skill")")"
  if [ -f ".ai/shared/skills/$name/SKILL.md" ]; then
    overrides+=("$name")
  fi
done

errors=0
fail() {
  echo "error: $1" >&2
  errors=$((errors + 1))
}

recorded_names=()
if [ -f "$record" ]; then
  while read -r recorded shared_path || [ -n "${recorded:-}" ]; do
    [ -n "${recorded:-}" ] || continue
    shared_path="${shared_path#\*}"
    name="$(basename "$(dirname "$shared_path")")"
    recorded_names+=("$name")

    if [ "$shared_path" != ".ai/shared/skills/$name/SKILL.md" ]; then
      fail "$record lists $shared_path; record shared skills as .ai/shared/skills/<name>/SKILL.md"
      continue
    fi
    if [ ! -f ".ai/local-skills/$name/SKILL.md" ]; then
      fail "$record lists $name, but .ai/local-skills/$name/SKILL.md does not exist; drop the line"
      continue
    fi
    if [ ! -f "$shared_path" ]; then
      fail "shared $name was removed: reconcile the local override .ai/local-skills/$name/SKILL.md and drop its line from $record"
      continue
    fi
    actual="$(shasum -a 256 "$shared_path" | cut -d ' ' -f 1)"
    if [ "$actual" != "$recorded" ]; then
      fail "shared $name changed: reconcile the local override .ai/local-skills/$name/SKILL.md"
      echo "  then record the new base: shasum -a 256 $shared_path, replacing its line in $record" >&2
    fi
  done <"$record"
elif [ "${#overrides[@]}" -gt 0 ]; then
  fail "$record is missing; record the shared base of each local override (${overrides[*]})"
fi

if [ -f "$record" ]; then
  for name in ${overrides[@]+"${overrides[@]}"}; do
    count=0
    for recorded_name in ${recorded_names[@]+"${recorded_names[@]}"}; do
      if [ "$recorded_name" = "$name" ]; then
        count=$((count + 1))
      fi
    done
    if [ "$count" -eq 0 ]; then
      fail "local skill $name overrides the shared one with no recorded base"
      echo "  reconcile it, then: shasum -a 256 .ai/shared/skills/$name/SKILL.md >> $record" >&2
    elif [ "$count" -gt 1 ]; then
      fail "$record lists $name $count times; keep one line"
    fi
  done
fi

if [ "$errors" -gt 0 ]; then
  exit 1
fi
