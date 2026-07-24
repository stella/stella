#!/usr/bin/env bash
set -euo pipefail

usage="usage: watch-github-run.sh RUN_ID WATCH_DEADLINE_EPOCH QUEUE_DEADLINE_EPOCH PHASE_DEADLINE_EPOCH"
run_id="${1:?$usage}"
watch_deadline_epoch="${2:?$usage}"
queue_deadline_epoch="${3:?$usage}"
phase_deadline_epoch="${4:?$usage}"

: "${INFRA_REPO:?INFRA_REPO must name the repository containing the run}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must name the step output file}"

: "${INFRA_WATCH_POLL_SECONDS:?source deploy-staging-watch-config.sh before invoking this script}"
: "${INFRA_WATCH_MAX_CONSECUTIVE_ERRORS:?source deploy-staging-watch-config.sh before invoking this script}"
: "${INFRA_WATCH_BUDGET_SECONDS:?source deploy-staging-watch-config.sh before invoking this script}"

for integer in \
  "$run_id" \
  "$watch_deadline_epoch" \
  "$queue_deadline_epoch" \
  "$phase_deadline_epoch"; do
  if [[ ! "$integer" =~ ^[0-9]+$ ]]; then
    echo "::error::Watcher arguments must be non-negative integers." >&2
    exit 1
  fi
done

poll_seconds="$INFRA_WATCH_POLL_SECONDS"
max_consecutive_errors="$INFRA_WATCH_MAX_CONSECUTIVE_ERRORS"
consecutive_errors=0
next_status_log_epoch=0

write_state() {
  {
    printf 'state=%s\n' "$1"
    printf 'watch_deadline_epoch=%s\n' "$watch_deadline_epoch"
  } >> "$GITHUB_OUTPUT"
}

echo "Watching infra run ${run_id}..."
while true; do
  now="$(date +%s)"
  if (( watch_deadline_epoch > 0 && now >= watch_deadline_epoch )); then
    echo "::error::Infra run ${run_id} did not complete before the watch deadline." >&2
    exit 1
  fi
  if (( watch_deadline_epoch == 0 && now >= queue_deadline_epoch )); then
    echo "::error::Infra run ${run_id} did not start before the queue deadline." >&2
    exit 1
  fi
  if (( now >= phase_deadline_epoch )); then
    echo "Watch phase ended with the infra run still active; refreshing credentials."
    write_state pending
    exit 0
  fi

  if (( watch_deadline_epoch == 0 )); then
    run_fields='[.status, (.conclusion // ""), .url, (.jobs[0].status // ""), (.jobs[0].startedAt // "")] | join("|")'
    run_json_fields='status,conclusion,url,jobs'
  else
    run_fields='[.status, (.conclusion // ""), .url, "", ""] | join("|")'
    run_json_fields='status,conclusion,url'
  fi

  if ! run_state="$(
    gh run view "$run_id" \
      --repo "$INFRA_REPO" \
      --json "$run_json_fields" \
      --jq "$run_fields" 2>&1
  )"; then
    consecutive_errors=$((consecutive_errors + 1))
    echo "::warning::Could not read infra run status (${consecutive_errors}/${max_consecutive_errors} transient errors): ${run_state}" >&2
    if (( consecutive_errors >= max_consecutive_errors )); then
      echo "::error::Giving up after repeated GitHub API errors while watching infra run ${run_id}." >&2
      exit 1
    fi
  else
    consecutive_errors=0
    IFS='|' read -r status conclusion url job_status job_started_at <<< "$run_state"

    if [[ "$status" == "completed" ]]; then
      if [[ "$conclusion" == "success" ]]; then
        echo "Infra run succeeded: ${url}"
        write_state succeeded
        exit 0
      fi

      echo "::error::Infra run completed with conclusion '${conclusion}': ${url}" >&2
      exit 1
    fi

    if (( watch_deadline_epoch == 0 )) \
      && [[ "$job_status" != "queued" ]] \
      && [[ -n "$job_started_at" ]] \
      && [[ "$job_started_at" != 0001-* ]]; then
      job_started_epoch="$(date --date="$job_started_at" +%s)"
      watch_deadline_epoch=$((job_started_epoch + INFRA_WATCH_BUDGET_SECONDS))
      echo "Infra job started at ${job_started_at}; watching through epoch ${watch_deadline_epoch}."
    fi

    now="$(date +%s)"
    if (( now >= next_status_log_epoch )); then
      echo "Infra run status: ${status}; job status: ${job_status:-unknown}"
      next_status_log_epoch=$((now + 60))
    fi
  fi

  # Re-read the clock after the API request. A slow request consumes budget;
  # it must not buy the loop another full sleep or another polling attempt.
  now="$(date +%s)"
  next_boundary="$phase_deadline_epoch"
  if (( watch_deadline_epoch > 0 && watch_deadline_epoch < next_boundary )); then
    next_boundary="$watch_deadline_epoch"
  fi
  if (( watch_deadline_epoch == 0 && queue_deadline_epoch < next_boundary )); then
    next_boundary="$queue_deadline_epoch"
  fi
  remaining_seconds=$((next_boundary - now))
  if (( remaining_seconds <= 0 )); then
    continue
  fi

  sleep_seconds="$poll_seconds"
  if (( remaining_seconds < sleep_seconds )); then
    sleep_seconds="$remaining_seconds"
  fi
  sleep "$sleep_seconds"
done
