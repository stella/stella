#!/usr/bin/env bash
# Exercise the release filters against the unfiltered open-PR listing.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
subject="$script_dir/release-pull-requests.sh"
stub_dir="$(mktemp -d)"
trap 'rm -rf "$stub_dir"' EXIT

cat > "$stub_dir/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for argument in "$@"; do
  if [[ "$argument" == "--search" || "$argument" == --search=* ]]; then
    echo "release recognition must not use the search index" >&2
    exit 1
  fi
done
if [[ "$1" == api ]]; then
  case "$2" in
    repos/stella/stella/pulls/4193) printf '%s\n' '{"draft":false,"title":"chore: release v1.2.3","base":{"sha":"base","ref":"main"},"head":{"sha":"head","repo":{"full_name":"stella/stella"}},"changed_files":0}' | jq --argjson files "${STELLA_TEST_RELEASE_FILES:-[]}" '.changed_files = ($files | length)' ;;
    'repos/stella/stella/compare/base...head') printf '%s\n' '{"merge_base_commit":{"sha":"base"}}' ;;
    'repos/stella/stella/pulls/4193/files?per_page=100') printf '%s\n' "${STELLA_TEST_RELEASE_FILES:-[]}" | jq -s '.' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
[[ "$*" == 'pr list --repo stella/stella --state open --base main --limit 500 --json number,title,isDraft,isCrossRepository' ]] || exit 1
printf '%s\n' "$STELLA_TEST_PULL_REQUESTS"
EOF
chmod +x "$stub_dir/gh"

fixtures='[
  {"number":4193,"title":"chore: release v0.9.43","isDraft":false,"isCrossRepository":false},
  {"number":4194,"title":"chore: release v0.9.44","isDraft":true,"isCrossRepository":false},
  {"number":4195,"title":"chore: release v0.9.45","isDraft":false,"isCrossRepository":true},
  {"number":4196,"title":"fix: chore: release v0.9.43","isDraft":false,"isCrossRepository":false},
  {"number":4197,"title":"chore: release notes","isDraft":false,"isCrossRepository":false}
]'

expect_output() {
  local name="$1" listing="$2" expected="$3"
  shift 3
  local actual
  actual="$(STELLA_TEST_PULL_REQUESTS="$listing" PATH="$stub_dir:$PATH" bash "$subject" "$@")"
  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL %s\nexpected: %s\nactual: %s\n' "$name" "$expected" "$actual" >&2
    exit 1
  fi
  echo "ok   $name"
}

expect_output "no release open" '[]' \
  $'open_other=0\ncurrent_is_release=false' --repo stella/stella --number 12
expect_output "workflow recognizes the release without a number" "$fixtures" \
  $'open_other=1\ncurrent_is_release=false' --repo stella/stella
expect_output "queue recognizes the current release" "$fixtures" \
  $'open_other=0\ncurrent_is_release=true' --repo stella/stella --number 4193
for number in 12 4194 4195 4196 4197; do
  expect_output "ignores non-release $number" "$fixtures" \
    $'open_other=1\ncurrent_is_release=false' --repo stella/stella --number "$number"
done

limit_fixture=$(jq -cn '[range(500) | {number:.,title:"fix: ordinary",isDraft:false,isCrossRepository:false}]')
if STELLA_TEST_PULL_REQUESTS="$limit_fixture" PATH="$stub_dir:$PATH" bash "$subject" --repo stella/stella >"$stub_dir/output" 2>"$stub_dir/error"; then
  echo "FAIL must refuse a partial listing" >&2
  exit 1
fi
[[ ! -s "$stub_dir/output" ]]
grep -q 'reached the 500 limit' "$stub_dir/error"

if STELLA_TEST_PULL_REQUESTS='[]' PATH="$stub_dir:$PATH" bash "$subject" --repo stella/stella --number abc >/dev/null 2>&1; then
  echo "FAIL rejects a non-numeric --number" >&2
  exit 1
fi
if PATH="$stub_dir:$PATH" bash "$subject" >/dev/null 2>&1; then
  echo "FAIL requires --repo" >&2
  exit 1
fi

python3 "$script_dir/check-release-pr-content.test.py"

if STELLA_TEST_PULL_REQUESTS="$fixtures" STELLA_TEST_RELEASE_FILES='[{"filename":"apps/api/src/not-versioning.ts","status":"modified"}]' PATH="$stub_dir:$PATH" bash "$subject" --repo stella/stella --number 4193 >"$stub_dir/output" 2>"$stub_dir/error"; then
  echo "FAIL must refuse source changes in a recognized release" >&2
  exit 1
fi
[[ ! -s "$stub_dir/output" ]]
grep -q 'apps/api/src/not-versioning.ts: not a versioning output' "$stub_dir/error"
echo "ok   recognized release fails closed on source changes"

STELLA_TEST_RELEASE_FILES='[{"filename":"apps/api/src/not-versioning.ts","status":"modified"}]' expect_output "unrelated PR is unaffected by invalid release" "$fixtures" \
  $'open_other=1\ncurrent_is_release=false' --repo stella/stella --number 12
