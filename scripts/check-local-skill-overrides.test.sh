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

unrecorded="$(new_fixture unrecorded)"
rm "$unrecorded/.ai/local-skills/shared-bases.sha256"
expect_status 0 "" "$script" "$unrecorded"

no_submodule="$(new_fixture no-submodule)"
rm -r "$no_submodule/.ai/shared"
expect_status 0 "skipped, .ai/shared is not checked out" "$script" "$no_submodule"

echo "check-local-skill-overrides tests passed"
