#!/usr/bin/env bash
#
# Tests for scripts/release-channel.sh.
#
# Covers:
#   - Stable tag → "prod"
#   - Each known prerelease channel (rc/beta/alpha) → matches
#   - Invalid tag formats fail fast
#   - The output is consistent — same tag always yields the same
#     string, which is the whole point of centralising this
#
# Run locally:    bash scripts/release-channel.test.sh
# Wired into CI in .github/workflows/ci.yml.
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/release-channel.sh"
PASS=0
FAIL=0
FAIL_NAMES=()

run_case() {
  local name="$1" tag="$2" expected_exit="$3" expected_out="$4"
  local actual_out actual_exit
  actual_out=$(bash "$SCRIPT" "$tag" 2>&1) && actual_exit=0 || actual_exit=$?

  if [[ "$actual_exit" != "$expected_exit" ]]; then
    FAIL=$((FAIL + 1))
    FAIL_NAMES+=("$name")
    printf '  ✗  %s (expected exit %s, got %s; output: %s)\n' \
      "$name" "$expected_exit" "$actual_exit" "$actual_out"
    return
  fi
  if [[ -n "$expected_out" && "$actual_out" != "$expected_out" ]]; then
    FAIL=$((FAIL + 1))
    FAIL_NAMES+=("$name")
    printf '  ✗  %s (expected output %q, got %q)\n' \
      "$name" "$expected_out" "$actual_out"
    return
  fi
  PASS=$((PASS + 1))
  printf '  ✓  %s\n' "$name"
}

echo "Running release-channel.sh tests..."

# -- valid stable tags → "prod" --
run_case "v0.0.1 → prod"        "v0.0.1"         0 "prod"
run_case "v1.2.3 → prod"        "v1.2.3"         0 "prod"
run_case "v10.20.30 → prod"     "v10.20.30"      0 "prod"

# -- known prerelease channels --
run_case "v0.0.2-rc.1 → rc"     "v0.0.2-rc.1"    0 "rc"
run_case "v0.0.2-rc.99 → rc"    "v0.0.2-rc.99"   0 "rc"
run_case "v1.0.0-beta.3 → beta" "v1.0.0-beta.3"  0 "beta"
run_case "v1.0.0-alpha.1 → alpha" "v1.0.0-alpha.1" 0 "alpha"

# -- invalid tags fail fast --
run_case "missing v prefix"     "0.0.1"          1 ""
run_case "trailing junk"        "v0.0.1-stable"  1 ""
run_case "no suffix number"     "v0.0.1-rc"      1 ""
run_case "uppercase channel"    "v0.0.1-RC.1"    1 ""
run_case "extra dots"           "v0.0.1.2"       1 ""
run_case "double dash"          "v0.0.1--rc.1"   1 ""
run_case "empty"                ""               1 ""
run_case "whitespace"           " "              1 ""

# -- consistency: same input → same output (idempotent) --
out1=$(bash "$SCRIPT" "v0.0.2-rc.5")
out2=$(bash "$SCRIPT" "v0.0.2-rc.5")
out3=$(bash "$SCRIPT" "v0.0.2-rc.5")
if [[ "$out1" == "$out2" && "$out2" == "$out3" ]]; then
  PASS=$((PASS + 1))
  printf '  ✓  idempotent across repeated calls\n'
else
  FAIL=$((FAIL + 1))
  FAIL_NAMES+=("idempotent across repeated calls")
  printf '  ✗  idempotent across repeated calls (%s/%s/%s)\n' "$out1" "$out2" "$out3"
fi

# -- consistency: stable tag never starts with `rc` etc. --
stable_out=$(bash "$SCRIPT" "v1.2.3")
if [[ "$stable_out" == "prod" ]]; then
  PASS=$((PASS + 1))
  printf '  ✓  stable tags never leak a prerelease channel name\n'
else
  FAIL=$((FAIL + 1))
  FAIL_NAMES+=("stable tags never leak a prerelease channel name")
  printf '  ✗  stable tag yielded %q (expected "prod")\n' "$stable_out"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -ne 0 ]]; then
  printf 'Failed cases:\n'
  printf '  - %s\n' "${FAIL_NAMES[@]}"
  exit 1
fi
