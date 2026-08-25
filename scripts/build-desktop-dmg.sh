#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <dmgbuild-python> <app-bundle> <output-dmg>" >&2
  exit 2
fi

dmgbuild_python=$1
app_bundle=$2
output_dmg=$3

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "desktop DMGs can only be built on macOS" >&2
  exit 1
fi

if [[ ! -x "$dmgbuild_python" ]]; then
  echo "dmgbuild Python is not executable: $dmgbuild_python" >&2
  exit 1
fi

if [[ ! -d "$app_bundle" || "$app_bundle" != *.app ]]; then
  echo "app bundle is missing or invalid: $app_bundle" >&2
  exit 1
fi

if [[ "$output_dmg" != *.dmg ]]; then
  echo "output must use the .dmg extension: $output_dmg" >&2
  exit 1
fi

if [[ -e "$output_dmg" ]]; then
  echo "refusing to overwrite existing DMG: $output_dmg" >&2
  exit 1
fi

repo_root=$(git rev-parse --show-toplevel)
settings="$repo_root/apps/desktop/dmg/settings.py"
background="$repo_root/apps/desktop/dmg/background.png"
volume_icon="$repo_root/apps/desktop/src-tauri/icons/icon.icns"

for asset in "$settings" "$background" "$volume_icon"; do
  if [[ ! -f "$asset" ]]; then
    echo "required DMG asset is missing: $asset" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$output_dmg")"

"$dmgbuild_python" -m dmgbuild \
  -s "$settings" \
  -D "app=$app_bundle" \
  -D "background=$background" \
  -D "volume_icon=$volume_icon" \
  "stella desktop" \
  "$output_dmg"
