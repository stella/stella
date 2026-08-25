#!/usr/bin/env bash
set -euo pipefail

dmg_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$dmg_dir/../../.." && pwd)
onboarding_gradient="$repo_root/apps/web/public/branding/onboarding-gradient-light.svg"
arrow_overlay="$dmg_dir/background.svg"

for command_name in rsvg-convert ffmpeg; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: $command_name is required to render the DMG background" >&2
    exit 1
  fi
done

for source_file in "$onboarding_gradient" "$arrow_overlay"; do
  if [[ ! -f "$source_file" ]]; then
    echo "error: source asset not found: $source_file" >&2
    exit 1
  fi
done

render_dir=$(mktemp -d "${TMPDIR:-/tmp}/stella-dmg-background.XXXXXX")
cleanup() {
  rm -rf -- "$render_dir"
}
trap cleanup EXIT

render_background() {
  local width=$1
  local height=$2
  local output=$3
  local suffix=$4
  local gradient_png="$render_dir/gradient-$suffix.png"
  local overlay_png="$render_dir/overlay-$suffix.png"

  rsvg-convert --width "$width" --height "$height" \
    "$onboarding_gradient" --output "$gradient_png"
  rsvg-convert --width "$width" --height "$height" \
    "$arrow_overlay" --output "$overlay_png"

  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "color=c=0xf5f5f4:s=${width}x${height}" \
    -i "$gradient_png" \
    -i "$overlay_png" \
    -filter_complex \
      "[1:v]format=rgba,colorchannelmixer=aa=0.28[rays];[0:v][rays]overlay[base];[base][2:v]overlay,format=rgb24" \
    -frames:v 1 \
    "$output"
}

render_background 660 400 "$dmg_dir/background.png" 1x
render_background 1320 800 "$dmg_dir/background@2x.png" 2x
