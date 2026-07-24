#!/usr/bin/env bash
set -uo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
watch_script="$repo_root/scripts/watch-github-run.sh"
config_script="$repo_root/scripts/deploy-staging-watch-config.sh"
workflow="$repo_root/.github/workflows/deploy-staging.yml"
pass=0
fail=0

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
    printf '  ✓ %s\n' "$name"
    return
  fi

  fail=$((fail + 1))
  printf '  ✗ %s (expected %q, got %q)\n' "$name" "$expected" "$actual"
}

setup_mocks() {
  test_dir="$(mktemp -d)"
  mock_bin="$test_dir/bin"
  mkdir -p "$mock_bin"
  printf '1000\n' > "$test_dir/clock"
  printf '0\n' > "$test_dir/calls"
  : > "$test_dir/output"

  cat > "$mock_bin/date" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == --date=* ]]; then
  printf '%s\n' "$WATCH_TEST_JOB_STARTED_EPOCH"
  exit 0
fi
cat "$WATCH_TEST_CLOCK"
EOF
  cat > "$mock_bin/sleep" <<'EOF'
#!/usr/bin/env bash
now="$(cat "$WATCH_TEST_CLOCK")"
printf '%s\n' "$((now + $1))" > "$WATCH_TEST_CLOCK"
EOF
  cat > "$mock_bin/gh" <<'EOF'
#!/usr/bin/env bash
calls="$(cat "$WATCH_TEST_CALLS")"
calls=$((calls + 1))
printf '%s\n' "$calls" > "$WATCH_TEST_CALLS"

if [[ -n "${WATCH_TEST_API_SECONDS:-}" ]]; then
  now="$(cat "$WATCH_TEST_CLOCK")"
  printf '%s\n' "$((now + WATCH_TEST_API_SECONDS))" > "$WATCH_TEST_CLOCK"
fi

case "$WATCH_TEST_MODE" in
  active) printf 'in_progress||https://example.invalid/run|in_progress|2026-01-01T00:00:00Z\n' ;;
  queued) printf 'queued||https://example.invalid/run|queued|\n' ;;
  success) printf 'completed|success|https://example.invalid/run|completed|2026-01-01T00:00:00Z\n' ;;
  failure) printf 'completed|failure|https://example.invalid/run|completed|2026-01-01T00:00:00Z\n' ;;
  api-error) printf 'temporary error\n' >&2; exit 1 ;;
esac
EOF
  chmod +x "$mock_bin/date" "$mock_bin/sleep" "$mock_bin/gh"
}

run_watch() {
  local deadline="$1" queue_deadline="$2" phase_deadline="$3"
  PATH="$mock_bin:$PATH" \
    GITHUB_OUTPUT="$test_dir/output" \
    INFRA_REPO=stella/stella-infra \
    INFRA_WATCH_POLL_SECONDS=10 \
    INFRA_WATCH_MAX_CONSECUTIVE_ERRORS=3 \
    INFRA_WATCH_BUDGET_SECONDS=30 \
    WATCH_TEST_CLOCK="$test_dir/clock" \
    WATCH_TEST_CALLS="$test_dir/calls" \
    WATCH_TEST_MODE="$WATCH_TEST_MODE" \
    WATCH_TEST_API_SECONDS="${WATCH_TEST_API_SECONDS:-}" \
    WATCH_TEST_JOB_STARTED_EPOCH="${WATCH_TEST_JOB_STARTED_EPOCH:-1000}" \
    bash "$watch_script" \
      123 "$deadline" "$queue_deadline" "$phase_deadline" >/dev/null 2>&1
}

cleanup_mocks() {
  rm -rf "$test_dir"
  unset \
    test_dir \
    mock_bin \
    WATCH_TEST_MODE \
    WATCH_TEST_API_SECONDS \
    WATCH_TEST_JOB_STARTED_EPOCH
}

echo "Running staging watcher tests..."

setup_mocks
WATCH_TEST_MODE=active
run_watch 1100 1200 1030
assert_eq \
  "active run ends phase as pending" \
  $'state=pending\nwatch_deadline_epoch=1100' \
  "$(cat "$test_dir/output")"
assert_eq "phase uses elapsed time" "3" "$(cat "$test_dir/calls")"
cleanup_mocks

setup_mocks
WATCH_TEST_MODE=active
WATCH_TEST_API_SECONDS=9
run_watch 1100 1200 1030
assert_eq "API latency consumes the phase budget" "2" "$(cat "$test_dir/calls")"
assert_eq "latency cannot overshoot the phase deadline" "1030" "$(cat "$test_dir/clock")"
cleanup_mocks

setup_mocks
WATCH_TEST_MODE=success
run_watch 1100 1200 1030
assert_eq \
  "successful child is terminal" \
  $'state=succeeded\nwatch_deadline_epoch=1100' \
  "$(cat "$test_dir/output")"
cleanup_mocks

setup_mocks
WATCH_TEST_MODE=failure
run_watch 1100 1200 1030
assert_eq "failed child fails watcher" "1" "$?"
cleanup_mocks

setup_mocks
WATCH_TEST_MODE=active
run_watch 1025 1200 1100
assert_eq "overall deadline fails an active child" "1" "$?"
assert_eq "overall deadline is not rounded to a poll" "1025" "$(cat "$test_dir/clock")"
cleanup_mocks

setup_mocks
WATCH_TEST_MODE=queued
run_watch 0 1025 1100
assert_eq "queued child has its own bounded deadline" "1" "$?"
assert_eq "queue deadline is exact" "1025" "$(cat "$test_dir/clock")"
cleanup_mocks

setup_mocks
WATCH_TEST_MODE=active
WATCH_TEST_JOB_STARTED_EPOCH=995
run_watch 0 1100 1010
assert_eq \
  "child deadline is anchored to actual job start" \
  $'state=pending\nwatch_deadline_epoch=1025' \
  "$(cat "$test_dir/output")"
cleanup_mocks

setup_mocks
WATCH_TEST_MODE=api-error
run_watch 1100 1200 1090
assert_eq "repeated API errors fail closed" "1" "$?"
assert_eq "API error limit is bounded" "3" "$(cat "$test_dir/calls")"
cleanup_mocks

# This is the cross-file architecture guard. The config is the only source of
# watch durations; the workflow sources it, rotates credentials between phases,
# and its job timeout must retain headroom for build plus the full watch budget.
source "$config_script"
assert_eq \
  "infra child timeout contract remains 60 minutes" \
  "3600" \
  "$INFRA_PROMOTE_TIMEOUT_SECONDS"
if (( INFRA_WATCH_BUDGET_SECONDS > INFRA_PROMOTE_TIMEOUT_SECONDS )); then
  pass=$((pass + 1))
  printf '  ✓ watcher outlives child timeout\n'
else
  fail=$((fail + 1))
  printf '  ✗ watcher must outlive child timeout\n'
fi
assert_eq "watcher has explicit ten-minute margin" "600" "$INFRA_WATCH_MARGIN_SECONDS"
assert_eq \
  "queue covers one child timeout plus margin" \
  "$INFRA_WATCH_BUDGET_SECONDS" \
  "$INFRA_PROMOTE_QUEUE_TIMEOUT_SECONDS"

if (( INFRA_WATCH_TOKEN_PHASE_SECONDS <= 3000 )); then
  pass=$((pass + 1))
  printf '  ✓ credentials rotate at least ten minutes before expiry\n'
else
  fail=$((fail + 1))
  printf '  ✗ credential phase must retain ten minutes of expiry headroom\n'
fi

if (( 3 * INFRA_WATCH_TOKEN_PHASE_SECONDS > INFRA_MAX_CALLER_WAIT_SECONDS )); then
  pass=$((pass + 1))
  printf '  ✓ three credential phases cover the maximum caller wait\n'
else
  fail=$((fail + 1))
  printf '  ✗ credential phases do not cover the maximum caller wait\n'
fi

workflow_job_timeout="$(
  awk '/name: Build \+ deploy staging/{in_job=1} in_job && /timeout-minutes:/{print $2; exit}' "$workflow"
)"
assert_eq \
  "workflow timeout matches checked config" \
  "$STAGING_DEPLOY_JOB_TIMEOUT_MINUTES" \
  "$workflow_job_timeout"

minimum_job_seconds=$((STAGING_IMAGE_BUILD_BUDGET_SECONDS + INFRA_MAX_CALLER_WAIT_SECONDS))
if (( workflow_job_timeout * 60 > minimum_job_seconds )); then
  pass=$((pass + 1))
  printf '  ✓ workflow job cannot preempt its build and watcher budgets\n'
else
  fail=$((fail + 1))
  printf '  ✗ workflow job timeout must exceed build plus watcher budgets\n'
fi

for required_pattern in \
  'source scripts/deploy-staging-watch-config.sh' \
  'queue_deadline_epoch=$((dispatch_epoch + INFRA_PROMOTE_QUEUE_TIMEOUT_SECONDS))' \
  'name: Refresh App token for the infra repo' \
  'name: Refresh App token for a queued staging promote' \
  'steps.initial-watch.outputs.state == '\''pending'\''' \
  'steps.refreshed-watch.outputs.state == '\''pending'\''' \
  'bash scripts/watch-github-run.sh'; do
  if grep -Fq "$required_pattern" "$workflow"; then
    pass=$((pass + 1))
    printf '  ✓ workflow invariant: %s\n' "$required_pattern"
  else
    fail=$((fail + 1))
    printf '  ✗ workflow invariant missing: %s\n' "$required_pattern"
  fi
done

printf '\nResults: %s passed, %s failed\n' "$pass" "$fail"
(( fail == 0 ))
