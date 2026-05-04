#!/usr/bin/env bash
# Build the Tauri updater manifest (latest.json) for a release.
#
# Reads RELEASE_REF, APP_VERSION, REPO from env. Pulls the GitHub
# Release's existing assets via `gh release view`, finds the platform
# updater archives + their .sig files, and emits the JSON the Tauri
# updater plugin expects on stdout.
#
# Tauri schema: https://v2.tauri.app/plugin/updater/#static-json-file
set -euo pipefail

: "${RELEASE_REF:?required}"
: "${APP_VERSION:?required}"
: "${REPO:?required}"

base="https://github.com/${REPO}/releases/download/${RELEASE_REF}"

# Fetch the asset list once. `gh` returns a JSON array; we pluck the
# names and look for the canonical Tauri filenames per platform.
assets_json="$(gh release view "$RELEASE_REF" --json assets --jq '.assets')"

# Look up the .sig contents for an asset name. Tauri requires the
# signature to be embedded inline, not a URL.
read_sig() {
  local name="$1"
  local sig_name="${name}.sig"
  local found
  found=$(echo "$assets_json" | jq -r --arg n "$sig_name" '.[] | select(.name == $n) | .url' | head -n1)
  if [[ -z "$found" || "$found" == "null" ]]; then
    return 1
  fi
  curl -fsSL -H "Authorization: token $GH_TOKEN" -H "Accept: application/octet-stream" "$found"
}

# Find an asset name matching a glob pattern.
find_asset() {
  echo "$assets_json" | jq -r --arg p "$1" '.[] | select(.name | test($p)) | .name' | head -n1
}

# Tauri 2's NSIS updater downloads the .exe directly and verifies it
# with the .exe.sig — there is no .nsis.zip wrapper. Confirmed against
# Yaak's live updater manifest, where the Windows entry points at
# `<basename>-setup.exe`. Point at the .exe we already produce.
windows_archive=$(find_asset '^Stella-windows-x64-setup\.exe$') || true
macos_archive=$(find_asset '^Stella-macos-universal\.app\.tar\.gz$') || true

platforms=""
if [[ -n "${windows_archive:-}" ]]; then
  sig=$(read_sig "$windows_archive")
  platforms+=$(jq -n --arg sig "$sig" --arg url "${base}/${windows_archive}" \
    '{"windows-x86_64": {"signature": $sig, "url": $url}}')
fi
if [[ -n "${macos_archive:-}" ]]; then
  sig=$(read_sig "$macos_archive")
  mac_block=$(jq -n --arg sig "$sig" --arg url "${base}/${macos_archive}" \
    '{"darwin-aarch64": {"signature": $sig, "url": $url}, "darwin-x86_64": {"signature": $sig, "url": $url}}')
  if [[ -z "$platforms" ]]; then
    platforms="$mac_block"
  else
    platforms=$(jq -n --argjson a "$platforms" --argjson b "$mac_block" '$a * $b')
  fi
fi

if [[ -z "$platforms" || "$platforms" == "{}" ]]; then
  echo "::error::No platform updater archives found on release $RELEASE_REF" >&2
  exit 1
fi

jq -n \
  --arg version "$APP_VERSION" \
  --arg pub_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg notes "Stella ${RELEASE_REF}" \
  --argjson platforms "$platforms" \
  '{version: $version, pub_date: $pub_date, notes: $notes, platforms: $platforms}'
