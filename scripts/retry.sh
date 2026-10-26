#!/usr/bin/env bash
set -euo pipefail

# Runs a command until it succeeds or the attempt budget is exhausted.
# Every wrapped command must be idempotent, because a retry repeats work a
# failed attempt may already have done. GitHub API commands use gh-retry.sh
# to classify HTTP failures before repeating an operation.
#
# Keep this bash 3.2 compatible (no mapfile, no associative arrays): macOS and
# Windows runners invoke it.

attempts="${RETRY_ATTEMPTS:-3}"
delays_seconds="${RETRY_DELAYS_SECONDS:-15 45}"
# A caller that tolerates the failure (continue-on-error) sets `warning`.
failure_level="${RETRY_FAILURE_LEVEL:-error}"
# Exit codes that are an answer, not a failure (`git ls-remote --exit-code`
# exits 2 for an absent ref): returned at once, without a retry.
passthrough_codes="${RETRY_PASSTHROUGH_EXIT_CODES:-}"

if [[ $# -eq 0 ]]; then
  echo "usage: retry.sh <command> [args...]" >&2
  exit 2
fi

if [[ "$failure_level" != error && "$failure_level" != warning ]]; then
  echo "RETRY_FAILURE_LEVEL must be error or warning" >&2
  exit 2
fi

# Workflow command data escaping, so the command text cannot end the
# annotation or start another workflow command.
command_text="$*"
command_text="${command_text//%/%25}"
command_text="${command_text//$'\r'/%0D}"
command_text="${command_text//$'\n'/%0A}"

if [[ ! "$attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "RETRY_ATTEMPTS must be a positive integer" >&2
  exit 2
fi

delays=()
read -ra delays <<<"$delays_seconds"

if ((${#delays[@]} == 0)); then
  echo "RETRY_DELAYS_SECONDS must be a space-separated list of non-negative integers" >&2
  exit 2
fi

passthrough=()
read -ra passthrough <<<"$passthrough_codes"
for code in ${passthrough[@]+"${passthrough[@]}"}; do
  if [[ ! "$code" =~ ^[1-9][0-9]*$ ]]; then
    echo "RETRY_PASSTHROUGH_EXIT_CODES must be a space-separated list of positive integers" >&2
    exit 2
  fi
done

for delay in "${delays[@]}"; do
  if [[ ! "$delay" =~ ^[0-9]+$ ]]; then
    echo "RETRY_DELAYS_SECONDS must be a space-separated list of non-negative integers" >&2
    exit 2
  fi
done

# Each retry prints one plain line; the outcome is reported once, as a single
# annotation, so a log never carries one banner per attempt. All of it goes to
# stderr: callers capture the command's stdout, which carries only its own.
for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  if "$@"; then
    if ((attempt > 1)); then
      echo "::warning::$command_text succeeded on attempt $attempt/$attempts" >&2
    fi
    exit 0
  else
    status=$?
  fi

  for code in ${passthrough[@]+"${passthrough[@]}"}; do
    if ((status == code)); then
      exit "$status"
    fi
  done

  if ((attempt == attempts)); then
    if ((attempts > 1)); then
      echo "::$failure_level::$command_text failed after $attempts attempts (exit $status)" >&2
    fi
    exit "$status"
  fi

  # The last delay repeats once the list is shorter than the attempt budget.
  index=$((attempt < ${#delays[@]} ? attempt : ${#delays[@]}))
  delay="${delays[index - 1]}"

  echo "retry.sh: attempt $attempt/$attempts failed (exit $status); retrying in ${delay}s: $command_text" >&2
  sleep "$delay"
done
