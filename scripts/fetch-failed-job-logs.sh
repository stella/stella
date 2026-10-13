#!/usr/bin/env bash
set -euo pipefail

# Downloads the logs of the jobs the CI result gate fails on, for the failure
# digest (scripts/ci-failure-digest.ts).
#
# Usage: fetch-failed-job-logs.sh <owner/repo> <jobs.json> <out-dir> [attempts] [delay-seconds]
#
# <jobs.json> is the run attempt's jobs as `gh api --paginate --slurp`
# returns them. Each log lands at <out-dir>/<job id>.log. Job logs can carry
# terminal escape sequences, which gh refuses to print unless allowed. A log
# the API does not serve yet (it can lag the job's completion) is retried a
# bounded number of times; one that stays unavailable is left out, and the
# digest reports that job by name and link.

if (($# < 3 || $# > 5)); then
  echo "usage: fetch-failed-job-logs.sh <owner/repo> <jobs.json> <out-dir> [attempts] [delay-seconds]" >&2
  exit 2
fi
repo=$1
jobs=$2
out=$3
attempts=${4:-3}
delay=${5:-10}
if [[ ! "$attempts" =~ ^[1-9][0-9]*$ || ! "$delay" =~ ^[0-9]+$ ]]; then
  echo "attempts must be a positive integer and delay-seconds a non-negative integer" >&2
  exit 2
fi
gh_retry=${GH_RETRY_SCRIPT:?GH_RETRY_SCRIPT must name scripts/gh-retry.sh}

mkdir -p "$out"
# The same jobs the digest reports: failed, timed out, or cancelled with a
# failed step. At most 20 logs.
ids=$(jq -r '
  [.[].jobs[]
    | select(.conclusion == "failure" or .conclusion == "timed_out"
      or (.conclusion == "cancelled" and any(.steps[]?; .conclusion == "failure")))
    | .id]
  | .[:20][]' "$jobs")

for id in $ids; do
  [[ "$id" =~ ^[0-9]+$ ]] || continue
  for ((attempt = 1; ; attempt += 1)); do
    if bash "$gh_retry" api --allow-escape-sequences "repos/$repo/actions/jobs/$id/logs" > "$out/$id.log" &&
      [[ -s "$out/$id.log" ]]; then
      break
    fi
    rm -f "$out/$id.log"
    if ((attempt >= attempts)); then
      echo "Log of job $id unavailable after $attempts attempts."
      break
    fi
    echo "Log of job $id not available yet (attempt $attempt/$attempts); retrying in ${delay}s."
    sleep "$delay"
  done
done
