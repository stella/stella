#!/usr/bin/env bash
set -euo pipefail

assets_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
desktop_dir=$(cd "$assets_dir/.." && pwd)
app_icon="$desktop_dir/src/shared/stella-app-icon.svg"
output="$desktop_dir/src-tauri/icons/tray-icon-32-tile.png"

# Windows and Linux draw tray images as given, without the tinting macOS
# applies to templates, so the tray shows the app icon tile there.
#
# Tauri hands the tray one RGBA bitmap (an .ico collapses to its largest
# entry), and Windows scales it to the tray slot: 16 px at 100% up to 32 px at
# 200%. A 32 px source matches the largest common slot and only ever
# downsamples.
size=32

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "error: rsvg-convert is required to render the tray tile" >&2
  exit 1
fi

if [[ ! -f "$app_icon" ]]; then
  echo "error: source asset not found: $app_icon" >&2
  exit 1
fi

rsvg-convert --width "$size" --height "$size" "$app_icon" --output "$output"
