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

gh_retry_script="${GH_RETRY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/gh-retry.sh}"

: "${RELEASE_REF:?required}"
: "${APP_VERSION:?required}"
: "${REPO:?required}"

base="https://github.com/${REPO}/releases/download/${RELEASE_REF}"

# Fetch the asset list once. `gh` returns a JSON array; we pluck the
# names and look for the canonical Tauri filenames per platform.
assets_json="$(bash "$gh_retry_script" release view "$RELEASE_REF" --json assets --jq '.assets')"

# Look up the .sig contents for an asset name. Tauri requires the
# signature to be embedded inline, not a URL.
#
# Use the `apiUrl` field (e.g. /repos/<owner>/<repo>/releases/assets/<id>)
# rather than the public `url` (the browser-download link). For
# private repos the browser link returns 404 even with a valid token —
# only the API endpoint with `Accept: application/octet-stream` serves
# the asset bytes.
read_sig() {
  local name="$1"
  local sig_name="${name}.sig"
  local found
  found=$(jq -r --arg n "$sig_name" 'first(.[] | select(.name == $n) | .apiUrl)' <<<"$assets_json")
  if [[ -z "$found" || "$found" == "null" ]]; then
    return 1
  fi
  bash "$gh_retry_script" api "$found" -H "Accept: application/octet-stream"
}

# Clients require the signed version (`requireSignedVersion`), so a
# signature whose trusted comment does not bind APP_VERSION would strand
# every installed client on this release. Refuse to publish it.
require_signed_version() {
  local name="$1"
  local sig="$2"
  local comment
  comment=$(printf '%s' "$sig" | base64 -d | sed -n 's/^trusted comment: //p')
  if ! grep -qxF "version:${APP_VERSION}" <<<"${comment//$'\t'/$'\n'}"; then
    echo "::error::${name}.sig does not bind version ${APP_VERSION} (trusted comment: ${comment})" >&2
    exit 1
  fi
}

# Find an asset name matching a glob pattern.
find_asset() {
  jq -r --arg p "$1" 'first(.[] | select(.name | test($p)) | .name)' <<<"$assets_json"
}

# Tauri 2's NSIS updater downloads the .exe directly and verifies it
# with the .exe.sig — there is no .nsis.zip wrapper. Confirmed against
# Yaak's live updater manifest, where the Windows entry points at
# `<basename>-setup.exe`. Point at the .exe we already produce.
windows_x64_archive=$(find_asset '^Stella-windows-x64-setup\.exe$') || true
windows_arm64_archive=$(find_asset '^Stella-windows-arm64-setup\.exe$') || true
macos_archive=$(find_asset '^Stella-macos-universal\.app\.tar\.gz$') || true

platforms='{}'

# List one signed archive under every updater key that downloads it. The
# keys are the `{os}-{arch}` strings the updater plugin looks up.
add_platforms() {
  local archive="$1" sig key
  shift
  if [[ -z "$archive" ]]; then
    return 0
  fi
  sig=$(read_sig "$archive")
  require_signed_version "$archive" "$sig"
  for key in "$@"; do
    platforms=$(jq -n --argjson platforms "$platforms" --arg key "$key" \
      --arg sig "$sig" --arg url "${base}/${archive}" \
      '$platforms + {($key): {signature: $sig, url: $url}}')
  done
}

add_platforms "${windows_x64_archive:-}" windows-x86_64
add_platforms "${windows_arm64_archive:-}" windows-aarch64
add_platforms "${macos_archive:-}" darwin-aarch64 darwin-x86_64

if [[ "$platforms" == "{}" ]]; then
  echo "::error::No platform updater archives found on release $RELEASE_REF" >&2
  exit 1
fi

jq -n \
  --arg version "$APP_VERSION" \
  --arg pub_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg notes "Stella ${RELEASE_REF}" \
  --argjson platforms "$platforms" \
  '{version: $version, pub_date: $pub_date, notes: $notes, platforms: $platforms}'
