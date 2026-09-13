#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

check_summary() {
  local expected_status="$1" expected_summary="$2" output actual_status=0
  shift 2
  output="$(
    source "$script_dir/verify-step.sh"
    for check_status in "$@"; do
      run_step "check-$check_status" bash -c 'exit "$1"' _ "$check_status"
    done
    finish_verification
  )" || actual_status=$?
  if [[ "$actual_status" -ne "$expected_status" || "$output" != *"$expected_summary"* ]]; then
    echo "Unexpected verification result ($actual_status): $output" >&2
    exit 1
  fi
  if [[ "$expected_summary" != 'verify: all checks passed' && "$output" == *'verify: all checks passed'* ]]; then
    echo "Verification claimed all checks passed despite a skip or failure: $output" >&2
    exit 1
  fi
}

check_summary 0 'verify: all checks passed' 0 0
check_summary 0 'skipped checks remain unverified' 0 77
check_summary 0 '2 check(s) skipped' 77 77
check_summary 1 '1 check(s) failed' 0 1
check_summary 1 '1 check(s) failed' 77 2 0
check_summary 1 '2 check(s) failed' 1 9 77

echo 'Verification status: all tests passed'
