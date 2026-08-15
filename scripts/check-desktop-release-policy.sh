#!/usr/bin/env bash
# Validate that a GitHub Release is a stable Stella application release with
# the assets required by the web download links and desktop updater.
set -euo pipefail

repo="${GH_REPO:?GH_REPO is required}"
latest_api_path="repos/${repo}/releases/latest"
api_path="${STELLA_DESKTOP_RELEASE_API_PATH:-$latest_api_path}"
expected_tag="${STELLA_DESKTOP_RELEASE_EXPECTED_TAG:-}"

release_json="$(gh api "$api_path")"
tag="$(jq -r '.tag_name // empty' <<< "$release_json")"

if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::GitHub latest must be a stable desktop release tag; got '${tag:-missing}'" >&2
  exit 1
fi

if [[ -n "$expected_tag" && "$tag" != "$expected_tag" ]]; then
  echo "::error::Expected GitHub latest to be $expected_tag; got $tag" >&2
  exit 1
fi

if ! jq -e '
  (.draft == false)
  and (.prerelease == false)
  and ([.assets[].name] as $assets
    | [
        "Stella-macos-universal.dmg",
        "Stella-windows-x64-setup.exe",
        "latest.json"
      ]
    | all(. as $required | $assets | index($required)))
' >/dev/null <<< "$release_json"; then
  echo "::error::Release $tag is draft, prerelease, or missing a required desktop asset" >&2
  exit 1
fi

if [[ "$api_path" == "$latest_api_path" ]]; then
  for asset in \
    "Stella-macos-universal.dmg" \
    "Stella-windows-x64-setup.exe"; do
    download_url="https://github.com/${repo}/releases/latest/download/${asset}"
    if ! curl \
      --fail \
      --head \
      --location \
      --max-time 30 \
      --retry 3 \
      --show-error \
      --silent \
      "$download_url" >/dev/null; then
      echo "::error::Desktop latest deep link failed: $download_url" >&2
      exit 1
    fi
  done
fi

echo "desktop-release-policy: ok ($tag)"
