#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
script="$script_dir/check-local-skill-overrides.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

new_fixture() {
  local fixture="$test_root/$1"
  mkdir -p "$fixture/.ai/shared/skills/example" "$fixture/.ai/local-skills/example"
  printf '%s\n' 'Shared instructions' >"$fixture/.ai/shared/skills/example/SKILL.md"
  printf '%s\n' 'Local instructions' >"$fixture/.ai/local-skills/example/SKILL.md"
  (cd "$fixture" && shasum -a 256 .ai/shared/skills/example/SKILL.md) \
    >"$fixture/.ai/local-skills/shared-bases.sha256"
  printf '%s\n' "$fixture"
}

expect_status() {
  local expected="$1" message="$2" output actual=0
  shift 2
  output="$(bash "$@" 2>&1)" || actual=$?
  if [[ "$actual" -ne "$expected" || "$output" != *"$message"* ]]; then
    echo "Expected status $expected containing '$message'; got $actual: $output" >&2
    exit 1
  fi
}

unchanged="$(new_fixture unchanged)"
expect_status 0 "" "$script" "$unchanged"

changed="$(new_fixture changed)"
printf '%s\n' 'Newer shared instructions' >"$changed/.ai/shared/skills/example/SKILL.md"
expect_status 1 "shared example changed: reconcile the local override" "$script" "$changed"

removed="$(new_fixture removed)"
rm "$removed/.ai/shared/skills/example/SKILL.md"
expect_status 1 "shared example was removed" "$script" "$removed"

orphan="$(new_fixture orphan)"
rm -r "$orphan/.ai/local-skills/example"
expect_status 1 "does not exist; drop the line" "$script" "$orphan"

deleted_ledger="$(new_fixture deleted-ledger)"
rm "$deleted_ledger/.ai/local-skills/shared-bases.sha256"
expect_status 1 "shared-bases.sha256 is missing" "$script" "$deleted_ledger"

unrecorded="$(new_fixture unrecorded)"
mkdir -p "$unrecorded/.ai/shared/skills/other" "$unrecorded/.ai/local-skills/other"
printf '%s\n' 'Shared other' >"$unrecorded/.ai/shared/skills/other/SKILL.md"
printf '%s\n' 'Local other' >"$unrecorded/.ai/local-skills/other/SKILL.md"
expect_status 1 "local skill other overrides the shared one with no recorded base" "$script" "$unrecorded"

duplicate="$(new_fixture duplicate)"
recorded_line="$(cat "$duplicate/.ai/local-skills/shared-bases.sha256")"
printf '%s\n' "$recorded_line" >>"$duplicate/.ai/local-skills/shared-bases.sha256"
expect_status 1 "lists example 2 times" "$script" "$duplicate"

local_only="$(new_fixture local-only)"
rm -r "$local_only/.ai/shared/skills/example"
rm "$local_only/.ai/local-skills/shared-bases.sha256"
expect_status 0 "" "$script" "$local_only"

no_submodule="$(new_fixture no-submodule)"
rm -r "$no_submodule/.ai/shared"
expect_status 0 "skipped, .ai/shared is not checked out" "$script" "$no_submodule"

echo "check-local-skill-overrides tests passed"
