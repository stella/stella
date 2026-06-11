#!/usr/bin/env bash
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/bun-ci-retry.sh"
PASS=0
FAIL=0
FAIL_NAMES=()

setup_case() {
  dir=$(mktemp -d)
  mkdir -p "$dir/bin"
  cat > "$dir/bin/bun" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail

count_file="${FAKE_BUN_COUNT_FILE:?}"
args_file="${FAKE_BUN_ARGS_FILE:?}"
succeed_on="${FAKE_BUN_SUCCEED_ON:-1}"
failure_status="${FAKE_BUN_FAILURE_STATUS:-7}"

count=0
if [[ -f "$count_file" ]]; then
  count=$(<"$count_file")
fi
count=$((count + 1))
printf '%s' "$count" > "$count_file"
printf '%s\n' "$*" >> "$args_file"

if [[ "$1" != "ci" ]]; then
  echo "expected bun ci" >&2
  exit 64
fi

if ((count >= succeed_on)); then
  exit 0
fi

exit "$failure_status"
EOF
  chmod +x "$dir/bin/bun"

  cat > "$dir/bin/sleep" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
printf '%s\n' "$*" >> "${FAKE_SLEEP_ARGS_FILE:?}"
EOF
  chmod +x "$dir/bin/sleep"

  export FAKE_BUN_COUNT_FILE="$dir/bun-count"
  export FAKE_BUN_ARGS_FILE="$dir/bun-args"
  export FAKE_SLEEP_ARGS_FILE="$dir/sleep-args"
}

teardown_case() {
  cd /
  rm -rf "$dir"
  unset dir
  unset FAKE_BUN_COUNT_FILE FAKE_BUN_ARGS_FILE FAKE_SLEEP_ARGS_FILE
  unset FAKE_BUN_SUCCEED_ON FAKE_BUN_FAILURE_STATUS
  unset BUN_CI_ATTEMPTS BUN_CI_RETRY_DELAY_SECONDS
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

echo "Running bun-ci-retry.sh tests..."

setup_case
PATH="$dir/bin:$PATH" bash "$SCRIPT" --ignore-scripts
assert_file "passes arguments to bun ci" "$FAKE_BUN_ARGS_FILE" "ci --ignore-scripts"
assert_file "does not sleep after first-attempt success" "$FAKE_SLEEP_ARGS_FILE" ""
teardown_case

setup_case
export FAKE_BUN_SUCCEED_ON=2
PATH="$dir/bin:$PATH" BUN_CI_RETRY_DELAY_SECONDS=0 bash "$SCRIPT" --ignore-scripts
assert_file "retries once after transient failure" "$FAKE_BUN_COUNT_FILE" "2"
assert_file "sleeps between attempts" "$FAKE_SLEEP_ARGS_FILE" "0"
teardown_case

setup_case
export FAKE_BUN_SUCCEED_ON=99
export FAKE_BUN_FAILURE_STATUS=23
PATH="$dir/bin:$PATH" BUN_CI_RETRY_DELAY_SECONDS=0 bash "$SCRIPT" --ignore-scripts \
  && actual=0 || actual=$?
if [[ "$actual" == "23" ]]; then
  PASS=$((PASS + 1))
  printf '  PASS  preserves final bun failure status\n'
else
  FAIL=$((FAIL + 1))
  FAIL_NAMES+=("preserves final bun failure status")
  printf '  FAIL  preserves final bun failure status (got %s)\n' "$actual"
fi
assert_file "stops after configured attempts" "$FAKE_BUN_COUNT_FILE" "2"
teardown_case

run_case "rejects invalid attempts" 2 env BUN_CI_ATTEMPTS=0 bash "$SCRIPT"
run_case "rejects invalid delay" 2 env BUN_CI_RETRY_DELAY_SECONDS=soon bash "$SCRIPT"

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -ne 0 ]]; then
  printf 'Failed cases:\n'
  printf '  - %s\n' "${FAIL_NAMES[@]}"
  exit 1
fi
