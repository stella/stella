#!/usr/bin/env bash
#
# Detect whether a changed-path list should run desktop Rust checks.
# Keep this as the single source of truth for Tauri Rust CI path rules.
set -euo pipefail

desktop_rust_checks_required=false

for file in "$@"; do
  case "$file" in
    apps/desktop/src-tauri/*|apps/desktop/fixtures/*|apps/desktop/src/i18n/langs/*|apps/desktop/src/clipboard/clipboard-types.ts|packages/api-contract/src/desktop-account-policy.json|packages/api-contract/src/desktop-edit-file-types.ts|packages/api-contract/src/desktop-rpc.gen.ts)
      desktop_rust_checks_required=true
      break
      ;;
  esac
done

echo "$desktop_rust_checks_required"
