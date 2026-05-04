#!/usr/bin/env bash
#
# Tests for scripts/check-bridge-version.sh.
#
# Runs the script against a series of throwaway git repos that
# simulate each branch-vs-main diff scenario the guard cares about
# and asserts the expected exit code (0 = OK, 1 = FAIL).
#
# Run locally:    bash scripts/check-bridge-version.test.sh
# Runs in CI:     wired in .github/workflows/ci.yml
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/check-bridge-version.sh"
PASS=0
FAIL=0
FAIL_NAMES=()

# Stable types.rs scaffold used by every scenario. Includes both
# const declarations the script greps for so version-bump diffs
# look realistic.
TYPES_RS=$(
  cat <<'EOF'
pub const BRIDGE_VERSION: u32 = 1;
pub const BRIDGE_CAPABILITIES: &[&str] = &[];
EOF
)

setup_repo() {
  dir=$(mktemp -d)
  cd "$dir"
  # Pin branch to `main` regardless of `init.defaultBranch` — the
  # guard always diffs against `main`, and on hosts that default
  # to `master` the diff would resolve to a non-existent ref.
  git init -q -b main
  git config user.email test@example.invalid
  git config user.name test
  mkdir -p apps/desktop/src-tauri/src apps/desktop/src/shared
  printf '%s\n' "$TYPES_RS" > apps/desktop/src-tauri/src/types.rs
  echo "// initial bridge" > apps/desktop/src-tauri/src/bridge.rs
  echo "// initial commands" > apps/desktop/src-tauri/src/commands.rs
  echo "// initial rpc" > apps/desktop/src/shared/rpc.ts
  echo "// other" > apps/desktop/src/unrelated.ts
  git add -A
  git commit -q -m "initial"
  git checkout -q -b feat
}

bump_version() {
  # Replace the integer in the BRIDGE_VERSION line.
  sed -i.bak 's/BRIDGE_VERSION: u32 = 1/BRIDGE_VERSION: u32 = 2/' \
    apps/desktop/src-tauri/src/types.rs
  rm -f apps/desktop/src-tauri/src/types.rs.bak
}

unbump_version() {
  # Lower the integer to simulate an accidental decrease.
  sed -i.bak 's/BRIDGE_VERSION: u32 = 1/BRIDGE_VERSION: u32 = 0/' \
    apps/desktop/src-tauri/src/types.rs
  rm -f apps/desktop/src-tauri/src/types.rs.bak
}

reformat_version_line() {
  # Edit the BRIDGE_VERSION line without changing the integer
  # (trailing comment). Old line-diff check would treat this as
  # a valid bump; the strict-increase check must reject it.
  sed -i.bak 's|BRIDGE_VERSION: u32 = 1;|BRIDGE_VERSION: u32 = 1; // tweak|' \
    apps/desktop/src-tauri/src/types.rs
  rm -f apps/desktop/src-tauri/src/types.rs.bak
}

run_case() {
  local name="$1" expected="$2"
  local out actual
  out=$(GITHUB_BASE_REF=main bash "$SCRIPT" 2>&1) && actual=0 || actual=$?
  if [[ "$actual" == "$expected" ]]; then
    PASS=$((PASS + 1))
    printf '  ✓  %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    FAIL_NAMES+=("$name")
    printf '  ✗  %s (expected exit %s, got %s)\n' "$name" "$expected" "$actual"
    printf '     output:\n'
    printf '       %s\n' "${out//$'\n'/$'\n       '}"
  fi
  cd /
  rm -rf "$dir"
  unset dir
}

echo "Running check-bridge-version.sh tests..."

# 1. No file changes at all → OK.
setup_repo
git commit --allow-empty -q -m "no-op"
run_case "no changes → 0" 0

# 2. Only an unrelated file changed → OK.
setup_repo
echo "// add" >> apps/desktop/src/unrelated.ts
git commit -aq -m "unrelated edit"
run_case "unrelated file → 0" 0

# 3. bridge.rs changed, version not bumped → FAIL.
setup_repo
echo "// new endpoint" >> apps/desktop/src-tauri/src/bridge.rs
git commit -aq -m "add bridge route"
run_case "bridge.rs changed, version unchanged → 1" 1

# 4. commands.rs changed, version not bumped → FAIL.
setup_repo
echo "// new tauri command" >> apps/desktop/src-tauri/src/commands.rs
git commit -aq -m "add command"
run_case "commands.rs changed, version unchanged → 1" 1

# 5. rpc.ts changed, version not bumped → FAIL.
setup_repo
echo "// new field" >> apps/desktop/src/shared/rpc.ts
git commit -aq -m "rpc field"
run_case "rpc.ts changed, version unchanged → 1" 1

# 6. bridge.rs changed AND version bumped → OK.
setup_repo
echo "// new endpoint" >> apps/desktop/src-tauri/src/bridge.rs
bump_version
git commit -aq -m "add bridge route + bump"
run_case "bridge.rs + version both changed → 0" 0

# 7. rpc.ts changed AND version bumped → OK.
setup_repo
echo "// new field" >> apps/desktop/src/shared/rpc.ts
bump_version
git commit -aq -m "rpc field + bump"
run_case "rpc.ts + version both changed → 0" 0

# 8. Only version bumped (no bridge files touched) → OK.
setup_repo
bump_version
git commit -aq -m "bump only"
run_case "only version changed → 0" 0

# 9. bridge.rs changed but only a non-version line in types.rs
#    edited → FAIL (catches "I touched types.rs but not the
#    version line").
setup_repo
echo "// new endpoint" >> apps/desktop/src-tauri/src/bridge.rs
echo "// stray comment" >> apps/desktop/src-tauri/src/types.rs
git commit -aq -m "bridge + non-version types edit"
run_case "bridge + non-version types edit → 1" 1

# 10. Multiple bridge files changed AND version bumped → OK.
setup_repo
echo "// new endpoint" >> apps/desktop/src-tauri/src/bridge.rs
echo "// new field" >> apps/desktop/src/shared/rpc.ts
bump_version
git commit -aq -m "multi-file bridge change + bump"
run_case "multiple bridge files + version → 0" 0

# 11. bridge.rs changed AND BRIDGE_VERSION line edited but integer
#     unchanged (e.g. trailing comment) → FAIL. Old line-diff
#     check would have passed this; strict-increase must reject.
setup_repo
echo "// new endpoint" >> apps/desktop/src-tauri/src/bridge.rs
reformat_version_line
git commit -aq -m "bridge + comment-only edit on version line"
run_case "bridge + comment-only version line edit → 1" 1

# 12. bridge.rs changed AND BRIDGE_VERSION decreased → FAIL.
#     A negative bump is never a valid compatibility signal.
setup_repo
echo "// new endpoint" >> apps/desktop/src-tauri/src/bridge.rs
unbump_version
git commit -aq -m "bridge + version decrease"
run_case "bridge + version decreased → 1" 1

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -ne 0 ]]; then
  printf 'Failed cases:\n'
  printf '  - %s\n' "${FAIL_NAMES[@]}"
  exit 1
fi
