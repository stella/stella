#!/usr/bin/env bash
set -euo pipefail

# Dispatches a workflow once, surviving GitHub server errors without starting
# a duplicate run.
#
# usage: gh-dispatch-workflow.sh <owner/repo> <workflow file> <ref> <run title> [input=value ...]
#
# <run title> is the display title the dispatched run gets from the target
# workflow's run-name. A dispatch answered with a 5xx, 429 or no response may
# or may not have created the run, so the POST is repeated only after the run
# list shows no new run with that title. Other 4xx responses fail at once.
# Runs that already carried the title before this call never count as ours.
#
# GitHub commands go through gh-retry.sh (GH_RETRY_SCRIPT, default: next to
# this script), which keeps response traces private; this script only reads
# its HTTP status metadata. bash 3.2 compatible.

if (($# < 4)); then
  echo 'usage: gh-dispatch-workflow.sh <owner/repo> <workflow file> <ref> <run title> [input=value ...]' >&2
  exit 2
fi
repo=$1
workflow=$2
ref=$3
title=$4
shift 4
if [[ ! "$repo" =~ ^[^/]+/[^/]+$ || ! "$workflow" =~ ^[A-Za-z0-9._-]+$ || -z "$ref" || -z "$title" ]]; then
  echo "gh-dispatch-workflow.sh: invalid repository, workflow, ref or title" >&2
  exit 2
fi
fields=(-f "ref=$ref")
for input in "$@"; do
  if [[ ! "$input" =~ ^[A-Za-z0-9_-]+= ]]; then
    echo "gh-dispatch-workflow.sh: inputs are name=value pairs" >&2
    exit 2
  fi
  fields+=(-f "inputs[${input%%=*}]=${input#*=}")
done

gh_retry=${GH_RETRY_SCRIPT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gh-retry.sh}
readonly attempts=4
# How long a run list is watched for a run GitHub may still be creating, and
# the pause between reads (tests shorten them).
settle_seconds=${GH_DISPATCH_SETTLE_SECONDS:-30}
poll_seconds=${GH_DISPATCH_POLL_SECONDS:-5}
if [[ ! "$settle_seconds" =~ ^[0-9]+$ || ! "$poll_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "gh-dispatch-workflow.sh: invalid settle or poll seconds" >&2
  exit 2
fi

umask 077
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

iso_time() {
  date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ
}
# The window tolerates runner clock skew; older runs are excluded by id below.
since=$(iso_time $(($(date -u +%s) - 600)))

# Prints the ids of dispatched runs with the title created inside the window.
matching_runs() {
  local runs
  runs=$(bash "$gh_retry" api --paginate --slurp \
    "/repos/$repo/actions/workflows/$workflow/runs?event=workflow_dispatch&created=%3E%3D$since&per_page=100") || return 1
  jq -r --arg title "$title" '.[].workflow_runs[] | select(.display_title == $title) | .id' <<< "$runs"
}

if ! existing=$(matching_runs); then
  echo "::error::Could not list $workflow runs before dispatching; nothing was dispatched." >&2
  exit 1
fi

# Prints the first matching run that did not exist before this call.
created_run() {
  local id
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    if ! grep -Fxq -- "$id" <<< "$existing"; then
      printf '%s\n' "$id"
      return 0
    fi
  done <<< "$1"
  return 0
}

for ((attempt=1; attempt<=attempts; attempt+=1)); do
  rm -f "$scratch/status"
  if GH_RETRY_STATUS_FILE="$scratch/status" bash "$gh_retry" api --method POST \
    "/repos/$repo/actions/workflows/$workflow/dispatches" "${fields[@]}" >/dev/null; then
    echo "Dispatched $workflow on $ref: $title"
    exit 0
  fi
  http=0
  retry_after=-1
  if [[ -s "$scratch/status" ]]; then
    read -r http retry_after < "$scratch/status" || true
  fi
  [[ "$http" =~ ^[0-9]+$ ]] || http=0
  [[ "$retry_after" =~ ^[0-9]+$ ]] || retry_after=-1
  rate_limited=false
  if ((http == 429 || http == 403 && retry_after >= 0)); then rate_limited=true; fi
  if ((http >= 400 && http <= 499)) && [[ "$rate_limited" == false ]]; then
    echo "::error::GitHub refused the $workflow dispatch with HTTP $http; it is not retried." >&2
    exit 1
  fi
  failure="HTTP $http"
  ((http > 0)) || failure='no HTTP response'
  echo "The $workflow dispatch ended with $failure (attempt $attempt/$attempts); checking whether GitHub created the run." >&2

  # Repeat the POST only once the run list shows the dispatch did not land.
  waited=0
  while :; do
    if ! runs=$(matching_runs); then
      echo "::error::Could not list $workflow runs after an unconfirmed dispatch; not dispatching again because the run may exist." >&2
      exit 1
    fi
    run_id=$(created_run "$runs")
    if [[ -n "$run_id" ]]; then
      echo "GitHub created run $run_id for $workflow despite the failed response; not dispatching again."
      exit 0
    fi
    ((waited < settle_seconds)) || break
    sleep "$poll_seconds"
    waited=$((waited + poll_seconds))
  done
  ((retry_after <= 60)) || retry_after=60
  if ((attempt < attempts && retry_after > waited)); then
    sleep $((retry_after - waited))
  fi
done
echo "::error::The $workflow dispatch failed $attempts times ($failure) and no '$title' run appeared within ${settle_seconds}s of any attempt." >&2
exit 1
