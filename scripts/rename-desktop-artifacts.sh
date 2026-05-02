#!/usr/bin/env bash
# Rename Tauri's version-stamped desktop bundle outputs to stable,
# version-less filenames so the web app can deep-link to
# `releases/latest/download/Stella-<platform>-<form>.<ext>` without
# knowing the current version.
#
# Stable names produced:
#   Stella-windows-x64-setup.exe          (NSIS installer, primary)
#   Stella-windows-x64.msi                (MSI installer, IT-managed)
#   Stella-windows-x64-setup.nsis.zip     (updater archive + .sig)
#   Stella-windows-x64.msi.zip            (updater archive + .sig)
#   Stella-macos-universal.dmg            (drag-to-Applications)
#   Stella-macos-universal.app.tar.gz     (updater archive + .sig)
#
# `.sig` files are renamed alongside their main artifact so the
# updater manifest builder can pair them.
set -euo pipefail

bundle_dir="${1:?usage: $0 <bundle dir>}"

if [[ ! -d "$bundle_dir" ]]; then
  echo "::error::bundle dir not found: $bundle_dir" >&2
  exit 1
fi

rename_pair() {
  local src="$1" dst="$2"
  if [[ -f "$src" ]]; then
    echo "  $(basename "$src") -> $(basename "$dst")"
    mv "$src" "$dst"
  fi
  if [[ -f "$src.sig" ]]; then
    echo "  $(basename "$src.sig") -> $(basename "$dst.sig")"
    mv "$src.sig" "$dst.sig"
  fi
}

# Each subdir contains exactly one main artifact per release; glob and
# rename. We don't hard-code the version in the source name.
shopt -s nullglob

# NSIS .exe + updater zip
for src in "$bundle_dir"/nsis/*-setup.exe; do
  rename_pair "$src" "$bundle_dir/nsis/Stella-windows-x64-setup.exe"
done
for src in "$bundle_dir"/nsis/*-setup.nsis.zip; do
  rename_pair "$src" "$bundle_dir/nsis/Stella-windows-x64-setup.nsis.zip"
done

# MSI + updater zip
for src in "$bundle_dir"/msi/*.msi; do
  rename_pair "$src" "$bundle_dir/msi/Stella-windows-x64.msi"
done
for src in "$bundle_dir"/msi/*.msi.zip; do
  rename_pair "$src" "$bundle_dir/msi/Stella-windows-x64.msi.zip"
done

# macOS DMG
for src in "$bundle_dir"/dmg/*.dmg; do
  rename_pair "$src" "$bundle_dir/dmg/Stella-macos-universal.dmg"
done

# macOS updater archive (under macos/ in newer Tauri, used to be under
# bundle/ — handle both)
for src in "$bundle_dir"/macos/*.app.tar.gz "$bundle_dir"/*.app.tar.gz; do
  rename_pair "$src" "$(dirname "$src")/Stella-macos-universal.app.tar.gz"
done
