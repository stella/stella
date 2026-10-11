#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
subject="$script_dir/check-main-merge-hold.sh"
stub_dir="$(mktemp -d)"
trap 'rm -rf "$stub_dir"' EXIT

cat > "$stub_dir/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2" == 'pr list' ]] || exit 99
if [[ "$STELLA_TEST_RELEASE_NUMBERS" == error ]]; then
  echo 'release listing unavailable' >&2
  exit 1
fi
# Support the baseline helper and its independent unfiltered-listing fix.
if [[ "$*" == *--jq* ]]; then
  printf '%s\n' "$STELLA_TEST_RELEASE_NUMBERS"
else
  jq -cn --arg numbers "$STELLA_TEST_RELEASE_NUMBERS" '[($numbers | split(" ")[] | select(length > 0) | tonumber) | {number:.,title:"chore: release v0.9.43",isDraft:false,isCrossRepository:false}]'
fi
EOF
chmod +x "$stub_dir/gh"

run_hold() {
  EVENT_NAME="$1" STELLA_MERGE_HOLD="$2" MERGE_GROUP_HEAD_REF="$3" \
    STELLA_TEST_RELEASE_NUMBERS="$4" REPOSITORY=stella/stella PATH="$stub_dir:$PATH" \
    bash "$subject" >"$stub_dir/output" 2>"$stub_dir/error"
}
ref='refs/heads/gh-readonly-queue/main/pr-123-abcdef'
run_hold pull_request 'release pending' malformed error
run_hold merge_group '' malformed error
run_hold merge_group 'release pending' "$ref" 123
if run_hold merge_group 'release pending' "$ref" 456; then
  echo 'FAIL ordinary queued PR must be held' >&2; exit 1
fi
grep -q 'MERGE HOLD: release pending' "$stub_dir/error"
if run_hold merge_group ' ' "$ref" ''; then
  echo 'FAIL whitespace must activate the hold' >&2; exit 1
fi
if run_hold merge_group 'release pending' malformed 123; then
  echo 'FAIL malformed queue refs must be refused' >&2; exit 1
fi
grep -q 'does not name a pull request' "$stub_dir/error"
if run_hold merge_group 'release pending' "$ref" error; then
  echo 'FAIL release listing errors must be refused' >&2; exit 1
fi
grep -q 'release listing unavailable' "$stub_dir/error"
# The authoritative read belongs to the final verdict, after aggregation.
workflow="$script_dir/../.github/workflows/ci.yml"
verdict_job=$(sed -n '/^  ci-result:/,$p' "$workflow")
[[ "$(grep -c 'name: Main merge hold' "$workflow")" == 1 ]]
grep -q 'name: Main merge hold' <<<"$verdict_job"
grep -q "if: github.event_name == 'merge_group' && vars.STELLA_MERGE_HOLD != ''" <<<"$verdict_job"
grep -q 'STELLA_MERGE_HOLD:.*vars.STELLA_MERGE_HOLD' <<<"$verdict_job"
grep -q 'scripts/release-pull-requests.sh' <<<"$verdict_job"
evaluation_line=$(grep -n 'name: Evaluate CI outcome' <<<"$verdict_job" | cut -d: -f1)
hold_line=$(grep -n 'name: Main merge hold' <<<"$verdict_job" | cut -d: -f1)
[[ "$hold_line" -gt "$evaluation_line" ]]

# Version Packages delegates only after its own variable gate.
release_workflow="$script_dir/../.github/workflows/release-pr.yml"
grep -q "if: needs.gate.outputs.may-version == 'true' && vars.STELLA_MERGE_HOLD == ''" "$release_workflow"
grep -qF 'auto-merge-command: head="$(gh pr view "$RELEASE_PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json headRefOid --jq .headRefOid)" && [ "${#head}" -eq 40 ] && gh pr merge "$RELEASE_PR_NUMBER" --repo "$GITHUB_REPOSITORY" --auto --match-head-commit "$head"' "$release_workflow"
# The release queue command never runs gh pr merge without a pinned head.
release_command=$(sed -n 's/^ *auto-merge-command: //p' "$release_workflow")
release_stub=$(mktemp -d)
trap 'rm -rf "$stub_dir" "$release_stub"' EXIT
cat > "$release_stub/gh" <<'STUB'
#!/usr/bin/env bash
if [[ "$1 $2" == 'pr view' ]]; then
  [[ "$VIEW" == fail ]] && exit 1
  printf '%s\n' "$VIEW"
  exit 0
fi
printf '%s\n' "$*" >> "$CALLS"
STUB
chmod +x "$release_stub/gh"
for view in fail '' 0123; do
  : > "$release_stub/calls"
  if PATH="$release_stub:$PATH" CALLS="$release_stub/calls" VIEW="$view" RELEASE_PR_NUMBER=7 GITHUB_REPOSITORY=o/r sh -c "$release_command"; then
    echo "FAIL release queue command succeeded for lookup '$view'" >&2; exit 1
  fi
  [[ ! -s "$release_stub/calls" ]] || { echo "FAIL queued without a pinned head ($view)" >&2; exit 1; }
done
: > "$release_stub/calls"
PATH="$release_stub:$PATH" CALLS="$release_stub/calls" VIEW=0123456789abcdef0123456789abcdef01234567 RELEASE_PR_NUMBER=7 GITHUB_REPOSITORY=o/r sh -c "$release_command"
[[ "$(cat "$release_stub/calls")" == 'pr merge 7 --repo o/r --auto --match-head-commit 0123456789abcdef0123456789abcdef01234567' ]]
echo 'check-main-merge-hold.test.sh: ok'
