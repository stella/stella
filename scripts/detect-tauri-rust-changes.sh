#!/usr/bin/env bash
#
# Detect whether a changed-path list should run desktop Rust checks.
# Keep this as the single source of truth for Tauri Rust CI path rules.
set -euo pipefail

desktop_rust_checks_required=false

for file in "$@"; do
  case "$file" in
    apps/desktop/src-tauri/*|apps/desktop/src/i18n/langs/*)
      desktop_rust_checks_required=true
      break
      ;;
  esac
done

echo "$desktop_rust_checks_required"
