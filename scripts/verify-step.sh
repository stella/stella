#!/usr/bin/env bash
# Exit 77 is reserved for deliberate skips; all other nonzero statuses fail.
failures=()
skipped_checks=()

run_step() {
  local name="$1"
  local check_status
  shift
  echo
  echo "=== $name ==="
  if "$@"; then
    echo "--- $name: ok"
    return
  else
    check_status=$?
  fi
  if [[ "$check_status" -eq 77 ]]; then
    echo "--- $name: SKIPPED"
    skipped_checks+=("$name")
    return
  fi
  echo "--- $name: FAILED"
  failures+=("$name")
}

finish_verification() {
  echo
  if (( ${#skipped_checks[@]} > 0 )); then
    echo "verify: ${#skipped_checks[@]} check(s) skipped:"
    printf ' - %s\n' "${skipped_checks[@]}"
  fi
  if (( ${#failures[@]} > 0 )); then
    echo "verify: ${#failures[@]} check(s) failed:"
    printf ' - %s\n' "${failures[@]}"
    return 1
  fi
  if (( ${#skipped_checks[@]} > 0 )); then
    echo "verify: all executed checks passed; skipped checks remain unverified"
    return
  fi
  echo "verify: all checks passed"
}
