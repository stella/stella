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
    newest_tag_ref="$(jq -ser '
      [ .[][] | select(.ref | test("^refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+$")) ]
      | sort_by(.ref | sub("^refs/tags/v"; "") | split(".") | map(tonumber))
      | last // empty
    ' <<< "$stable_tags")"
    newest_tag="$(jq -r '.ref | sub("^refs/tags/"; "")' <<< "$newest_tag_ref")"
    if [[ "$tag" != "$newest_tag" ]]; then
      release_error_file="$(mktemp)"
      if newest_release="$(bash "$gh_retry_script" api "repos/${repo}/releases/tags/${newest_tag}" 2>"$release_error_file")"; then
        rm -f "$release_error_file"
      else
        if grep -Eq '^GitHub command failed: HTTP 404, attempt [0-9]+/4 \(exit [0-9]+\)$' "$release_error_file"; then
          newest_release='{}'
        else
          rm -f "$release_error_file"
          echo "::error::Newest desktop release metadata unavailable" >&2
          exit 1
        fi
        rm -f "$release_error_file"
      fi
      tag_object_type="$(jq -r '.object.type // empty' <<< "$newest_tag_ref")"
      tag_object_sha="$(jq -r '.object.sha // empty' <<< "$newest_tag_ref")"
      case "$tag_object_type" in
        tag|commit) ;;
        *) echo "::error::Newest stable application tag has an invalid Git object" >&2; exit 1 ;;
      esac

      publishing=false
      [[ "$(jq -r '.draft // false' <<< "$newest_release")" == true ]] && publishing=true
      workflow_created_at=''
      for workflow in release.yml release-desktop.yml; do
        # release-desktop.yml starts from workflow_run, so its runs report the
        # default branch, never the tag: match them by run name instead.
        case "$workflow" in
          release.yml) runs_query="branch=${newest_tag}&per_page=10" ;;
          release-desktop.yml) runs_query="per_page=30" ;;
        esac
        runs="$(bash "$gh_retry_script" api "repos/${repo}/actions/workflows/${workflow}/runs?${runs_query}")" || { echo "::error::Desktop release workflow metadata unavailable" >&2; exit 1; }
        if [[ "$workflow" == release-desktop.yml ]]; then
          runs="$(jq --arg title "Release Desktop App ${newest_tag}" '.workflow_runs |= map(select(.display_title == $title))' <<< "$runs")"
        fi
        workflow_created_at="$(jq -r --arg earliest "$workflow_created_at" '
          [$earliest, (.workflow_runs[]?.created_at // empty)]
          | map(select(length > 0))
          | sort
          | first // empty
        ' <<< "$runs")"
        if jq -e '(.workflow_runs | sort_by(.created_at) | last // {}) | .conclusion == "failure"' >/dev/null <<< "$runs"; then
          echo "::error::Desktop release workflow failed for the newest stable application tag" >&2
          exit 1
        fi
        if jq -e '(.workflow_runs | sort_by(.created_at) | last // {}) | (.status == "queued" or .status == "in_progress")' >/dev/null <<< "$runs"; then
          publishing=true
        fi
      done

      publishing_created_at="$workflow_created_at"
      if [[ -z "$publishing_created_at" && "$tag_object_type" == tag ]]; then
        tag_object="$(bash "$gh_retry_script" api "repos/${repo}/git/tags/${tag_object_sha}")" || { echo "::error::Newest stable application tag metadata unavailable" >&2; exit 1; }
        publishing_created_at="$(jq -r '.tagger.date // empty' <<< "$tag_object")"
      fi
      if [[ -z "$publishing_created_at" ]]; then
        echo "::error::Newest stable application tag has no release workflow or annotated tag creation time" >&2
        exit 1
      fi
      now_epoch="${STELLA_DESKTOP_NOW_EPOCH:-$(date +%s)}"
      publishing_age_seconds="$(jq -nr --arg created_at "$publishing_created_at" --argjson now "$now_epoch" '
        if ($created_at | fromdateiso8601?) == null then empty
        else ($now - ($created_at | fromdateiso8601) | floor)
        end
      ')"
      if [[ -z "$publishing_age_seconds" ]]; then
        echo "::error::Newest stable application tag has no valid publishing time" >&2
        exit 1
      fi
      if (( publishing_age_seconds < 0 )); then
        echo "::error::Newest stable application tag publishing time is in the future" >&2
        exit 1
      fi

      publishing_window_seconds=10800
      if [[ "$publishing" == true ]] && (( publishing_age_seconds >= 0 && publishing_age_seconds < publishing_window_seconds )); then
        echo "desktop-release-policy: publishing"
        exit 0
      fi
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
