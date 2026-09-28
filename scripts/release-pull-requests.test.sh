#!/usr/bin/env bash
# Tests for release-pull-requests.sh with a stub `gh` that prints the release
# numbers its --jq filter would select.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
subject="$script_dir/release-pull-requests.sh"
stub_dir="$(mktemp -d)"
trap 'rm -rf "$stub_dir"' EXIT

cat > "$stub_dir/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${STUB_RELEASES:-}"
EOF
chmod +x "$stub_dir/gh"

failures=0
expect_output() {
  local name="$1" releases="$2" expected="$3"
  shift 3
  local actual
  actual="$(STUB_RELEASES="$releases" PATH="$stub_dir:$PATH" bash "$subject" "$@")"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL $name"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    failures=$((failures + 1))
  else
    echo "ok   $name"
  fi
}

expect_output "no release open" "" \
  $'open_other=0\ncurrent_is_release=false' --repo stella/stella --number 12
expect_output "another release is open" "4014" \
  $'open_other=1\ncurrent_is_release=false' --repo stella/stella --number 12
expect_output "the pull request is the release" "4014" \
  $'open_other=0\ncurrent_is_release=true' --repo stella/stella --number 4014
expect_output "counts every release without a number" "4014 4020" \
  $'open_other=2\ncurrent_is_release=false' --repo stella/stella

if STUB_RELEASES="" PATH="$stub_dir:$PATH" bash "$subject" --repo stella/stella --number abc >/dev/null 2>&1; then
  echo "FAIL rejects a non-numeric --number"
  failures=$((failures + 1))
else
  echo "ok   rejects a non-numeric --number"
fi
if PATH="$stub_dir:$PATH" bash "$subject" >/dev/null 2>&1; then
  echo "FAIL requires --repo"
  failures=$((failures + 1))
else
  echo "ok   requires --repo"
fi

if [[ "$failures" -gt 0 ]]; then
  echo "$failures failure(s)"
  exit 1
fi
