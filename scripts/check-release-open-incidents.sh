#!/usr/bin/env bash
# Shared by RC creation and finalization: an open incident blocks both.
set -euo pipefail
repo="${1:?repository is required}"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || exit 2
gh_retry_script="${GH_RETRY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/gh-retry.sh}"
incidents=$(bash "$gh_retry_script" api --paginate --slurp "repos/$repo/issues?state=open&labels=main-health-incident&per_page=100")
jq -e '[.[][]] | length == 0' <<< "$incidents" >/dev/null || {
  echo '::error::RELEASE_OPEN_MAIN_INCIDENT: an unresolved main-health incident blocks tagging' >&2
  exit 1
}
