#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
detector="$script_dir/detect-tauri-rust-changes.sh"

assert_detection() {
  local expected="$1"
  shift
  local actual
  actual=$(bash "$detector" "$@")
  if [[ "$actual" != "$expected" ]]; then
    echo "Expected $expected for $*, received $actual" >&2
    exit 1
  fi
}

assert_detection true apps/desktop/src-tauri/src/types.rs
assert_detection true apps/desktop/src/i18n/langs/en.json
assert_detection true apps/desktop/src/shared/rpc.gen.ts
assert_detection true packages/api-contract/src/desktop-edit-file-types.ts
assert_detection false apps/desktop/src/shared/rpc.ts
assert_detection false apps/web/src/lib/desktop-bridge.ts

echo "Desktop Rust change detector tests passed."
