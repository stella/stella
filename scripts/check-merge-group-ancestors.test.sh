#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
subject="$script_dir/check-merge-group-ancestors.sh"
stub_dir="$(mktemp -d)"
trap 'rm -rf "$stub_dir"' EXIT

# Responses are numbered per poll; the last one repeats.
cat > "$stub_dir/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == api ]] || exit 99
case "$2" in
  */compare/main...*) key=compare ;;
  */commits/*/check-runs*) key="runs-$(sed -E 's#.*/commits/([^/]+)/.*#\1#' <<<"$2")" ;;
  *) exit 98 ;;
esac
count_file="$FIXTURES/$key.count"
count=$(($(cat "$count_file" 2>/dev/null || echo 0) + 1))
echo "$count" > "$count_file"
response="$FIXTURES/$key.$count"
[[ -f "$response" ]] || response=$(ls "$FIXTURES/$key".[0-9]* | sort -t. -k2 -n | tail -n 1)
if [[ "$(cat "$response")" == error ]]; then
  echo 'API unavailable' >&2
  exit 1
fi
cat "$response"
EOF
chmod +x "$stub_dir/gh"

main=1111111111111111111111111111111111111111
a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
# The group base: the nearest queued group ahead.
b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
rebuilt=cccccccccccccccccccccccccccccccccccccccc
pull=dddddddddddddddddddddddddddddddddddddddd
commit() {
  jq -cn --arg sha "$1" --args '{sha: $sha, parents: [$ARGS.positional[] | {sha: .}], commit: {message: "change \($sha[0:7]) (#1)\n\nbody"}}' "${@:2}"
}
# A linear queue on top of main, oldest first; the last commit is the base.
queue() {
  local status="$1" parent="$main" commits=() sha
  shift
  for sha in "$@"; do
    commits+=("$(commit "$sha" "$parent")")
    parent="$sha"
  done
  jq -cn --arg status "$status" --args '{status: $status, total_commits: ($ARGS.positional | length), commits: [$ARGS.positional[] | fromjson]}' ${commits[@]+"${commits[@]}"}
}
run() {
  printf '{"check_runs":[{"id":1,"status":"%s","conclusion":%s}]}' "$1" "$2"
}
no_run='{"check_runs":[]}'

fixtures=""
reset() {
  fixtures="$(mktemp -d "$stub_dir/case.XXXX")"
}
put() {
  printf '%s\n' "$2" > "$fixtures/$1"
}
check() {
  EVENT_NAME="${EVENT:-merge_group}" REPOSITORY=stella/stella \
    MERGE_GROUP_BASE_SHA="$b" MERGE_GROUP_BASE_REF=refs/heads/main \
    ANCESTOR_WAIT_SECONDS="${WAIT:-60}" ANCESTOR_POLL_SECONDS=0 \
    FIXTURES="$fixtures" PATH="$stub_dir:$PATH" \
    bash "$subject" >"$stub_dir/output" 2>"$stub_dir/error"
}
expect_pass() {
  check || { echo "FAIL $1 must pass" >&2; cat "$stub_dir/error" >&2; exit 1; }
}
expect_fail() {
  if check; then
    echo "FAIL $1 must fail closed" >&2; exit 1
  fi
  grep -qF "$2" "$stub_dir/error" || {
    echo "FAIL $1 must report: $2" >&2; cat "$stub_dir/error" >&2; exit 1
  }
}

# Pull requests never consult the queue.
reset
EVENT=pull_request expect_pass 'a pull request'

# The first group in the queue has nothing ahead.
reset
put compare.1 "$(queue identical)"
expect_pass 'a group built on main'

# Every group ahead passed.
reset
put compare.1 "$(queue ahead "$a" "$b")"
put "runs-$a.1" "$(run completed '"success"')"
put "runs-$b.1" "$(run completed '"success"')"
expect_pass 'groups ahead that passed'

# Each failing conclusion of a group ahead fails closed and names it.
for conclusion in failure cancelled timed_out skipped neutral action_required stale; do
  reset
  put compare.1 "$(queue ahead "$a" "$b")"
  put "runs-$a.1" "$(run completed '"success"')"
  put "runs-$b.1" "$(run completed "\"$conclusion\"")"
  expect_fail "a group ahead with $conclusion" "did not pass (ci-result $conclusion): $b change ${b:0:7} (#1)"
done

# A group ahead that is still running is waited for.
reset
put compare.1 "$(queue ahead "$b")"
put "runs-$b.1" "$(run in_progress null)"
put "runs-$b.2" "$no_run"
put "runs-$b.3" "$(run completed '"success"')"
expect_pass 'a group ahead that passes while waiting'
grep -q 'Waiting for 1 queued group(s) ahead' "$stub_dir/output"

# A group ahead that fails while waiting fails closed.
reset
put compare.1 "$(queue ahead "$b")"
put "runs-$b.1" "$(run queued null)"
put "runs-$b.2" "$(run completed '"failure"')"
expect_fail 'a group ahead that fails while waiting' "did not pass (ci-result failure): $b"

# The wait is bounded: a pending or missing verdict times out closed.
for pending in "$(run in_progress null)" "$no_run"; do
  reset
  put compare.1 "$(queue ahead "$b")"
  put "runs-$b.1" "$pending"
  WAIT=0 expect_fail 'a group ahead that never finishes' "did not finish within 0s: $b"
done

# A failed group the queue replaced is not in the base's history; only its
# rebuilt replacement is judged.
reset
put compare.1 "$(queue ahead "$rebuilt" "$b")"
put "runs-$a.1" "$(run completed '"failure"')"
put "runs-$rebuilt.1" "$(run completed '"success"')"
put "runs-$b.1" "$(run completed '"success"')"
expect_pass 'a rebuilt group ahead that passed'
[[ ! -e "$fixtures/runs-$a.count" ]]

# A group ahead that merged while waiting leaves the comparison.
reset
put compare.1 "$(queue ahead "$a" "$b")"
put compare.2 "$(queue ahead "$b")"
put "runs-$a.1" "$(run in_progress null)"
put "runs-$b.1" "$(run completed '"success"')"
expect_pass 'a group ahead that merged while waiting'

# A merge commit group brings its pull request's own commits into the range;
# only the groups on the first-parent line are judged.
reset
put compare.1 "$(jq -cn --args '{status: "ahead", total_commits: 3, commits: [$ARGS.positional[] | fromjson]}' \
  "$(commit "$a" "$main")" "$(commit "$pull" "$main")" "$(commit "$b" "$a" "$pull")")"
put "runs-$a.1" "$(run completed '"success"')"
put "runs-$b.1" "$(run completed '"success"')"
put "runs-$pull.1" "$no_run"
WAIT=0 expect_pass 'a merge commit group with pull request commits'
[[ ! -e "$fixtures/runs-$pull.count" ]]

# A truncated comparison may hide a failing group, so it fails closed.
reset
put compare.1 "$(queue ahead "$a" "$b" | jq -c '.total_commits = 300')"
put "runs-$a.1" "$(run completed '"success"')"
put "runs-$b.1" "$(run completed '"success"')"
expect_fail 'a truncated comparison' 'is truncated'

# A base that is not on top of main, or an unreadable queue, fails closed.
for status in behind diverged; do
  reset
  put compare.1 "$(queue "$status")"
  expect_fail "a $status base" "is $status relative to main"
done
reset
put compare.1 error
expect_fail 'an unreadable queue' 'API unavailable'
reset
put compare.1 "$(queue ahead "$b")"
put "runs-$b.1" error
expect_fail 'an unreadable verdict' 'API unavailable'

# The final verdict job runs the check on every merge group.
workflow="$script_dir/../.github/workflows/ci.yml"
verdict_job=$(sed -n '/^  ci-result:/,$p' "$workflow")
[[ "$(grep -c 'name: Queued groups ahead passed' "$workflow")" == 1 ]]
grep -q "if: github.event_name == 'merge_group'$" <<<"$(grep -A1 'name: Queued groups ahead passed' <<<"$verdict_job")"
grep -q 'bash .workflow-tooling/scripts/check-merge-group-ancestors.sh' <<<"$verdict_job"
grep -q '            scripts/check-merge-group-ancestors.sh' <<<"$verdict_job"
evaluation_line=$(grep -n 'name: Evaluate CI outcome' <<<"$verdict_job" | cut -d: -f1)
ancestor_line=$(grep -n 'name: Queued groups ahead passed' <<<"$verdict_job" | cut -d: -f1)
[[ "$ancestor_line" -gt "$evaluation_line" ]]
echo 'check-merge-group-ancestors.test.sh: ok'
