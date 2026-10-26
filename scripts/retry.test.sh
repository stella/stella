#!/usr/bin/env bash
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/retry.sh"
PASS=0
FAIL=0
FAIL_NAMES=()

setup_case() {
  dir=$(mktemp -d)
  mkdir -p "$dir/bin"
  cat > "$dir/bin/flaky" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail

count_file="${FAKE_COUNT_FILE:?}"
args_file="${FAKE_ARGS_FILE:?}"
succeed_on="${FAKE_SUCCEED_ON:-1}"
failure_status="${FAKE_FAILURE_STATUS:-7}"

count=0
if [[ -f "$count_file" ]]; then
  count=$(<"$count_file")
fi
count=$((count + 1))
printf '%s' "$count" > "$count_file"
printf '%s\n' "$*" >> "$args_file"

if ((count >= succeed_on)); then
  exit 0
fi

exit "$failure_status"
EOF
  chmod +x "$dir/bin/flaky"

  cat > "$dir/bin/sleep" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
printf '%s\n' "$*" >> "${FAKE_SLEEP_ARGS_FILE:?}"
EOF
  chmod +x "$dir/bin/sleep"

  export FAKE_COUNT_FILE="$dir/count"
  export FAKE_ARGS_FILE="$dir/args"
  export FAKE_SLEEP_ARGS_FILE="$dir/sleep-args"
}

teardown_case() {
  cd /
  rm -rf "$dir"
  unset dir
  unset FAKE_COUNT_FILE FAKE_ARGS_FILE FAKE_SLEEP_ARGS_FILE
  unset FAKE_SUCCEED_ON FAKE_FAILURE_STATUS
  unset RETRY_ATTEMPTS RETRY_DELAYS_SECONDS
}

run_case() {
  local name="$1" expected_exit="$2"
  shift 2

  setup_case
  local output actual
  output=$(PATH="$dir/bin:$PATH" "$@" 2>&1) && actual=0 || actual=$?

  if [[ "$actual" == "$expected_exit" ]]; then
    PASS=$((PASS + 1))
    printf '  PASS  %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    FAIL_NAMES+=("$name")
    printf '  FAIL  %s (expected exit %s, got %s)\n' "$name" "$expected_exit" "$actual"
    printf '     output:\n'
    printf '       %s\n' "${output//$'\n'/$'\n       '}"
  fi

  teardown_case
}

assert_file() {
  local name="$1" file="$2" expected="$3"
  local actual

  if [[ -f "$file" ]]; then
    actual=$(<"$file")
  else
    actual=""
  fi

  if [[ "$actual" == "$expected" ]]; then
    PASS=$((PASS + 1))
    printf '  PASS  %s\n' "$name"
    return
  fi

  FAIL=$((FAIL + 1))
  FAIL_NAMES+=("$name")
  printf '  FAIL  %s (expected %q, got %q)\n' "$name" "$expected" "$actual"
}

echo "Running retry.sh tests..."

# The script's own output is captured: a passing test must not emit workflow
# commands (annotations) into the CI log it runs in.
setup_case
PATH="$dir/bin:$PATH" bash "$SCRIPT" flaky ci --ignore-scripts > "$dir/output" 2>&1
assert_file "passes arguments through to the command" "$FAKE_ARGS_FILE" "ci --ignore-scripts"
assert_file "does not sleep after first-attempt success" "$FAKE_SLEEP_ARGS_FILE" ""
assert_file "prints nothing after first-attempt success" "$dir/output" ""
teardown_case

setup_case
export FAKE_SUCCEED_ON=4
PATH="$dir/bin:$PATH" RETRY_ATTEMPTS=4 bash "$SCRIPT" flaky ci > "$dir/output" 2>&1
assert_file "retries until the command succeeds" "$FAKE_COUNT_FILE" "4"
assert_file "repeats the last delay once the list runs out" "$FAKE_SLEEP_ARGS_FILE" "15
45
45"
assert_file "reports a recovered command once" "$dir/output" "retry.sh: attempt 1/4 failed (exit 7); retrying in 15s: flaky ci
retry.sh: attempt 2/4 failed (exit 7); retrying in 45s: flaky ci
retry.sh: attempt 3/4 failed (exit 7); retrying in 45s: flaky ci
::warning::flaky ci succeeded on attempt 4/4"
teardown_case

setup_case
export FAKE_SUCCEED_ON=99
export FAKE_FAILURE_STATUS=23
PATH="$dir/bin:$PATH" RETRY_DELAYS_SECONDS=0 bash "$SCRIPT" flaky ci > "$dir/output" 2>&1 \
  && actual=0 || actual=$?
if [[ "$actual" == "23" ]]; then
  PASS=$((PASS + 1))
  printf '  PASS  preserves the final command status\n'
else
  FAIL=$((FAIL + 1))
  FAIL_NAMES+=("preserves the final command status")
  printf '  FAIL  preserves the final command status (got %s)\n' "$actual"
fi
assert_file "stops after configured attempts" "$FAKE_COUNT_FILE" "3"
assert_file "reports an exhausted command once" "$dir/output" "retry.sh: attempt 1/3 failed (exit 23); retrying in 0s: flaky ci
retry.sh: attempt 2/3 failed (exit 23); retrying in 0s: flaky ci
::error::flaky ci failed after 3 attempts (exit 23)"
teardown_case

setup_case
export FAKE_SUCCEED_ON=99
PATH="$dir/bin:$PATH" RETRY_ATTEMPTS=2 RETRY_DELAYS_SECONDS=0 RETRY_FAILURE_LEVEL=warning \
  bash "$SCRIPT" flaky "100%" $'a\n::error::injected' > "$dir/output" 2>&1
assert_file "a tolerated failure is a warning with escaped command text" "$dir/output" "retry.sh: attempt 1/2 failed (exit 7); retrying in 0s: flaky 100%25 a%0A::error::injected
::warning::flaky 100%25 a%0A::error::injected failed after 2 attempts (exit 7)"
teardown_case

setup_case
export FAKE_SUCCEED_ON=99
export FAKE_FAILURE_STATUS=2
status=0
PATH="$dir/bin:$PATH" RETRY_DELAYS_SECONDS=0 RETRY_PASSTHROUGH_EXIT_CODES="2 4" \
  bash "$SCRIPT" flaky ci > "$dir/output" 2>&1 || status=$?
if [[ "$status" == 2 ]]; then
  PASS=$((PASS + 1))
  printf '  PASS  returns a listed exit code as an answer\n'
else
  FAIL=$((FAIL + 1))
  FAIL_NAMES+=("returns a listed exit code as an answer")
  printf '  FAIL  returns a listed exit code as an answer (got %s)\n' "$status"
fi
assert_file "does not retry a listed exit code" "$FAKE_COUNT_FILE" "1"
assert_file "reports nothing for a listed exit code" "$dir/output" ""
teardown_case

run_case "rejects invalid passthrough exit codes" 2 env RETRY_PASSTHROUGH_EXIT_CODES=absent bash "$SCRIPT" flaky ci
run_case "rejects invalid attempts" 2 env RETRY_ATTEMPTS=0 bash "$SCRIPT" flaky ci
run_case "rejects invalid delays" 2 env RETRY_DELAYS_SECONDS=soon bash "$SCRIPT" flaky ci
run_case "rejects an empty delay list" 2 env RETRY_DELAYS_SECONDS=" " bash "$SCRIPT" flaky ci
run_case "rejects a missing command" 2 env bash "$SCRIPT"
run_case "rejects an unknown failure level" 2 env RETRY_FAILURE_LEVEL=notice bash "$SCRIPT" flaky ci

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -ne 0 ]]; then
  printf 'Failed cases:\n'
  printf '  - %s\n' "${FAIL_NAMES[@]}"
  exit 1
fi
