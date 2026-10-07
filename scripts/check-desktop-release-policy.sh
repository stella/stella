#!/usr/bin/env bash
# Validate that a GitHub Release is a stable Stella application release with
# the assets required by the web download links and desktop updater.
set -euo pipefail

gh_retry_script="${GH_RETRY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/gh-retry.sh}"

repo="${GH_REPO:?GH_REPO is required}"
latest_api_path="repos/${repo}/releases/latest"
api_path="${STELLA_DESKTOP_RELEASE_API_PATH:-$latest_api_path}"
expected_tag="${STELLA_DESKTOP_RELEASE_EXPECTED_TAG:-}"

release_json="$(bash "$gh_retry_script" api "$api_path")" || { echo "::error::Desktop release metadata unavailable" >&2; exit 1; }
tag="$(jq -r '.tag_name // empty' <<< "$release_json")"

if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::GitHub latest must be a stable desktop release tag; got an invalid tag" >&2
  exit 1
fi

if [[ -n "$expected_tag" && "$tag" != "$expected_tag" ]]; then
  echo "::error::GitHub latest does not match the expected desktop release" >&2
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
  echo "::error::Release is draft, prerelease, or missing a required desktop asset" >&2
  exit 1
fi

if [[ "$api_path" == "$latest_api_path" ]]; then
  if [[ -z "$expected_tag" ]]; then
    stable_tags="$(bash "$gh_retry_script" api --paginate "repos/${repo}/git/matching-refs/tags/v")" || { echo "::error::Desktop stable tag metadata unavailable" >&2; exit 1; }
    newest_tag="$(jq -ser '
      [ .[][] | .ref | sub("^refs/tags/"; "")
        | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")) ]
      | sort_by(ltrimstr("v") | split(".") | map(tonumber))
      | last | strings
    ' <<< "$stable_tags")"
    if [[ "$tag" != "$newest_tag" ]]; then
      echo "::error::Desktop latest must match the newest stable application tag" >&2
      exit 1
    fi
  fi
  # One bounded retry per installer; a pass that needed it says so.
  retry_pause="${STELLA_DESKTOP_RETRY_PAUSE_SECONDS:-5}"
  head_installer() {
    local rc=0
    curl \
      --fail \
      --head \
      --location \
      --max-time 30 \
      --show-error \
      --silent \
      "$1" >/dev/null 2>&1 || rc=$?
    if [[ "$rc" == 0 ]]; then return 0; fi
    if [[ "$rc" == 28 ]]; then first_reason=timeout; else first_reason=http_status; fi
    return 1
  }
  for asset in \
    "Stella-macos-universal.dmg" \
    "Stella-windows-x64-setup.exe"; do
    download_url="${STELLA_DESKTOP_DOWNLOAD_BASE_URL:-https://github.com/${repo}/releases/latest/download}/${asset}"
    first_reason=
    if head_installer "$download_url"; then continue; fi
    sleep "$retry_pause"
    if head_installer "$download_url"; then
      printf 'journey desktop_installer passed_after_retry %s\n' "$first_reason"
      continue
    fi
    echo "::error::Desktop latest deep link failed" >&2
    exit 1
  done
fi

echo "desktop-release-policy: ok"
