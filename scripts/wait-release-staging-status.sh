#!/usr/bin/env bash
# One shared deadline covers every version commit in a HEADGREEN group.
set -euo pipefail
repo="${GITHUB_REPOSITORY:?}"
commits="${RELEASE_VERSION_COMMITS:?}"
jq -e 'type == "array" and all(.[]; type == "string" and test("^[0-9a-f]{40}$"))' <<< "$commits" >/dev/null
pending=()
while IFS= read -r sha; do
  [[ -z "$sha" ]] || pending+=("$sha")
done < <(jq -r '.[]' <<< "$commits")
timeout_seconds="${RELEASE_STATUS_TIMEOUT_SECONDS:-7200}"
[[ "$timeout_seconds" =~ ^[1-9][0-9]{0,3}$ && "$timeout_seconds" -le 7200 ]] \
  || { echo '::error::RELEASE_STAGING_REFUSED: timeout must be 1..7200 seconds' >&2; exit 1; }
readonly DEADLINE=$((SECONDS + timeout_seconds))
while (( ${#pending[@]} > 0 )); do
  remaining=()
  for sha in "${pending[@]}"; do
    # Combined statuses deduplicate contexts to their latest state. Pagination
    # retains staging/verified when a commit carries many other contexts.
    statuses=$(bash "${GH_RETRY_SCRIPT:-$(dirname "$0")/gh-retry.sh}" api --paginate --slurp "repos/$repo/commits/$sha/status?per_page=100")
    state=$(jq -r '[.[].statuses[] | select(.context == "staging/verified")] | first | .state // "missing"' <<< "$statuses")
    case "$state" in
      success) ;;
      failure|error)
        echo "::error::RELEASE_STAGING_FAILED: $sha staging/verified is $state" >&2
        exit 1 ;;
      pending|missing) remaining+=("$sha") ;;
      *) echo "::error::RELEASE_STAGING_REFUSED: unknown status $state" >&2; exit 1 ;;
    esac
  done
  (( ${#remaining[@]} > 0 )) || exit 0
  if (( SECONDS >= DEADLINE )); then
    echo "::error::RELEASE_STAGING_TIMEOUT: staging/verified missing after ${timeout_seconds} seconds: ${remaining[*]}" >&2
    exit 1
  fi
  pending=("${remaining[@]}")
  sleep 30
done
