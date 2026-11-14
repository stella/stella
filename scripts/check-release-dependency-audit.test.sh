#!/usr/bin/env bash
set -euo pipefail
subject="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-release-dependency-audit.sh"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/bin"
cat > "$fixture/bin/bun" <<'STUB'
#!/usr/bin/env bash
exit "${TEST_AUDIT_STATUS:?}"
STUB
chmod +x "$fixture/bin/bun"
export PATH="$fixture/bin:$PATH"

# The gate prints GitHub workflow commands; captured here so a negative case
# never becomes a real annotation on the job that runs this test.
check() {
  local expected_status="$1" expected_output="$2" status=0 output
  shift 2
  output=$(env "$@" bash "$subject" 2>&1) || status=$?
  if [[ "$status" -ne "$expected_status" ]]; then
    echo "FAIL $*: exit $status, expected $expected_status" >&2
    exit 1
  fi
  if [[ "$output" != *"$expected_output"* ]]; then
    echo "FAIL $*: output lacks the expected message" >&2
    exit 1
  fi
}

check 0 "" TEST_AUDIT_STATUS=0 WAIVE_DEPENDENCY_AUDIT=false WAIVER_REASON=
check 1 "" TEST_AUDIT_STATUS=1 WAIVE_DEPENDENCY_AUDIT=false WAIVER_REASON=
check 0 "Dependency audit explicitly waived: Reviewed for this release" \
  TEST_AUDIT_STATUS=1 WAIVE_DEPENDENCY_AUDIT=true WAIVER_REASON='Reviewed for this release'
check 1 "" TEST_AUDIT_STATUS=1 WAIVE_DEPENDENCY_AUDIT=true WAIVER_REASON=' '
check 2 "waiver cannot cover exit status 2" \
  TEST_AUDIT_STATUS=2 WAIVE_DEPENDENCY_AUDIT=true WAIVER_REASON='Reviewed for this release'
check 3 "waiver cannot cover exit status 3" \
  TEST_AUDIT_STATUS=3 WAIVE_DEPENDENCY_AUDIT=true WAIVER_REASON='Reviewed for this release'
check 1 "The dependency audit waiver cannot be supplied when the audit passes." \
  TEST_AUDIT_STATUS=0 WAIVE_DEPENDENCY_AUDIT=true WAIVER_REASON='Unused waiver'
echo 'ok   release audit waives only new findings and rejects baseline failures'
