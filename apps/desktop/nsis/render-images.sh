#!/usr/bin/env bash
set -euo pipefail

nsis_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$nsis_dir/../../.." && pwd)
onboarding_gradient="$repo_root/apps/web/public/branding/onboarding-gradient-light.svg"
symbol="$repo_root/apps/landing/public/brand/stella-symbol.svg"
# The lockup ships only inside `apps/landing/public/brand/stella-logos.zip`, so
# the sidebar renders from a copy kept next to this script.
wordmark="$nsis_dir/stella-wordmark.svg"

# NSIS reads both images as uncompressed 24-bit bitmaps: the sidebar (164x314)
# fills the welcome and finish pages, the header (150x57) sits above every
# other page.
#
# Tauri's installer.nsi is PerMonitorV2 DPI-aware and defines neither
# MUI_WELCOMEFINISHPAGE_BITMAP_NOSTRETCH nor MUI_HEADERIMAGE_BITMAP_NOSTRETCH,
# so NSIS scales both bitmaps to their controls; rendering at 2x downsamples
# sharply on a 150-200% display where a 1x bitmap would be upscaled and blurred.
image_scale=2

sidebar_width=$((164 * image_scale))
sidebar_height=$((314 * image_scale))
sidebar_wordmark_width=$((120 * image_scale))
sidebar_wordmark_top=$((40 * image_scale))
header_width=$((150 * image_scale))
header_height=$((57 * image_scale))
header_symbol_height=$((36 * image_scale))
header_padding=$((12 * image_scale))

for command_name in rsvg-convert ffmpeg; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: $command_name is required to render the NSIS images" >&2
    exit 1
  fi
done

for source_file in "$onboarding_gradient" "$symbol" "$wordmark"; do
  if [[ ! -f "$source_file" ]]; then
    echo "error: source asset not found: $source_file" >&2
    exit 1
  fi
done

render_dir=$(mktemp -d "${TMPDIR:-/tmp}/stella-nsis-images.XXXXXX")
cleanup() {
  rm -rf -- "$render_dir"
}
trap cleanup EXIT

render_sidebar() {
  local gradient_png="$render_dir/sidebar-gradient.png"
  local wordmark_png="$render_dir/sidebar-wordmark.png"

  # The gradient paints its own opaque white ground, so it needs no base layer.
  rsvg-convert --width "$sidebar_width" --height "$sidebar_height" \
    "$onboarding_gradient" --output "$gradient_png"
  rsvg-convert --width "$sidebar_wordmark_width" "$wordmark" \
    --output "$wordmark_png"

  ffmpeg -hide_banner -loglevel error -y \
    -i "$gradient_png" \
    -i "$wordmark_png" \
    -filter_complex \
      "[0:v][1:v]overlay=x=(W-w)/2:y=${sidebar_wordmark_top},format=bgr24" \
    -frames:v 1 \
    "$nsis_dir/sidebar.bmp"
}

render_header() {
  local symbol_png="$render_dir/header-symbol.png"

  rsvg-convert --height "$header_symbol_height" "$symbol" --output "$symbol_png"

  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "color=c=white:s=${header_width}x${header_height}" \
    -i "$symbol_png" \
    -filter_complex \
      "[0:v][1:v]overlay=x=W-w-${header_padding}:y=(H-h)/2,format=bgr24" \
    -frames:v 1 \
    "$nsis_dir/header.bmp"
}

render_sidebar
render_header
