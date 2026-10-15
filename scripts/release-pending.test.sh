#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
subject="$script_dir/release-pending.sh"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/bin"
cat > "$fixture/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"$TEST_FAIL_ENDPOINT"* && -n "$TEST_FAIL_ENDPOINT" ]]; then
  echo 'API unavailable' >&2
  exit 1
fi
case "$*" in
  'api repos/stella/stella/contents/VERSION?ref=main --jq .content')
    printf '%s' "$TEST_VERSION" | base64 ;;
  'api --paginate --slurp repos/stella/stella/git/matching-refs/tags/v'*)
    printf '%s\n' "$TEST_REFS" ;;
  'pr list --repo stella/stella --state open --base main --limit 500 --json number,title,isDraft,isCrossRepository')
    printf '%s\n' "$TEST_PRS" ;;
  *) echo "Unexpected gh call: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$fixture/bin/gh"
export PATH="$fixture/bin:$PATH"
export TEST_VERSION=1.2.3 TEST_REFS='[[]]' TEST_PRS='[]' TEST_FAIL_ENDPOINT=''
expect_state() {
  local expected="$1"
  [[ "$(bash "$subject" --repo stella/stella)" == "$(printf 'version_state=%s\nversion=%s' "$expected" "$TEST_VERSION")" ]]
}
expect_state pending
export TEST_REFS='[[{"ref":"refs/tags/v1.2.3-rc.1"}]]'
expect_state pending
export TEST_REFS='[[{"ref":"refs/tags/v1.2.3-rc.1"}],[{"ref":"refs/tags/v1.2.3"}]]'
expect_state tagged
echo 'ok   only the exact version tag closes the pending window, including later pages'
export TEST_VERSION=1.2.3-rc.1 TEST_REFS='[[{"ref":"refs/tags/v1.2.3-rc.1"}]]'
expect_state tagged
export TEST_REFS='[[]]'
expect_state pending
echo 'ok   prerelease versions use their own exact tag'
expect_failure() {
  if bash "$subject" --repo stella/stella >"$fixture/output" 2>"$fixture/error"; then
    echo 'FAIL invalid or unavailable state accepted' >&2; exit 1
  fi
  [[ ! -s "$fixture/output" ]]
}
export TEST_VERSION=invalid
expect_failure
grep -q 'Invalid VERSION' "$fixture/error"
export TEST_VERSION=1.2.3
for endpoint in contents/VERSION matching-refs; do
  export TEST_FAIL_ENDPOINT="$endpoint"
  expect_failure
  grep -q 'GitHub command failed: HTTP 0, attempt 1/4 (exit 1)' "$fixture/error"
done
export TEST_FAIL_ENDPOINT='' TEST_REFS='not-json'
expect_failure
echo 'ok   version and API failures propagate without reporting release state'
# Exercise the actual automatic versioning gate.
sed -n '/^          set -euo pipefail$/,/^  version:/ {
  /^  version:/d
  s/^          //
  p
}' "$script_dir/../.github/workflows/release-pr.yml" > "$fixture/gate.sh"
cd "$script_dir/.."
export REPOSITORY=stella/stella GITHUB_OUTPUT="$fixture/gate-output"
expect_gate() {
  local expected="$1"
  : > "$GITHUB_OUTPUT"
  bash "$fixture/gate.sh" >"$fixture/gate-log"
  [[ "$(cat "$GITHUB_OUTPUT")" == "may-version=$expected" ]]
}
export TEST_REFS='[[]]'
expect_gate false
export TEST_REFS='[[{"ref":"refs/tags/v1.2.3"}]]' MANUAL=false
expect_gate true
export TEST_PRS='[{"number":1,"title":"chore: release v1.2.4","isDraft":false,"isCrossRepository":false}]'
expect_gate false
export MANUAL=true
expect_gate false
echo 'ok   pending tags and open-release ownership prevent automatic versioning'
