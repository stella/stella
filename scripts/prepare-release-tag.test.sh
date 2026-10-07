#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
subject="$script_dir/prepare-release-tag.sh"
workflow="$script_dir/../.github/workflows/release-tag.yml"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/bin"
cat > "$fixture/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "${TEST_API_ERROR:-}" != "$*" ]] || { echo "API unavailable" >&2; exit 1; }
case "$*" in
  *"/commits/$TEST_CANDIDATE/statuses?per_page=100"*)
    jq --argjson heavy "$TEST_HEAVY_STATUS" '.[0] += [$heavy]' <<< "$TEST_STATUSES" ;;
  *"/commits/${TEST_LATER:-none}/statuses?per_page=100"*) printf '%s\n' "$TEST_LATER_STATUSES" ;;
  *"/statuses?per_page=100"*) echo '[[]]' ;;
  *"/actions/runs/7"*) printf '%s\n' "$TEST_HEAVY_RUN" ;;
  *"/compare/$TEST_CANDIDATE...main"*) printf '%s\n' "$TEST_COMPARISON" ;;
  *"/issues?"*) printf '%s\n' "$TEST_INCIDENTS" ;;
  *) echo "unexpected API request: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$fixture/bin/gh"
export PATH="$fixture/bin:$PATH"
export TEST_CANDIDATE TEST_HEAVY_RUN TEST_COMPARISON TEST_HEAVY_STATUS TEST_STATUSES TEST_REAL_GIT
export TEST_STATUSES='[[{"context":"staging/verified","state":"success"}]]'
git init -q "$fixture/repo"
cd "$fixture/repo"
git config user.name test
git config user.email test@example.com
git config commit.gpgsign false
git config tag.gpgsign false
printf '1.2.3\n' > VERSION
mkdir .changeset
printf '# Changesets\n' > .changeset/README.md
git add .
git commit -qm candidate
TEST_CANDIDATE=$(git rev-parse HEAD)
git commit --allow-empty -qm later
main=$(git rev-parse HEAD)
reset_health() {
  export TEST_HEAVY_STATUS='{"context":"main/heavy","state":"success","creator":{"login":"github-actions[bot]","type":"Bot"},"target_url":"https://github.com/stella/stella/actions/runs/7"}'
  TEST_HEAVY_RUN=$(jq -nc --arg sha "$TEST_CANDIDATE" '{id:7,html_url:"https://github.com/stella/stella/actions/runs/7",repository:{full_name:"stella/stella"},path:".github/workflows/main-heavy.yml",head_branch:"main",event:"push",display_title:("Main heavy suites " + $sha),head_sha:$sha,status:"completed",conclusion:"success"}')
  TEST_COMPARISON=$(jq -nc --arg sha "$TEST_CANDIDATE" '{status:"ahead",merge_base_commit:{sha:$sha}}')
  export TEST_INCIDENTS='[[]]' TEST_API_ERROR=''
}
reset_health
git update-ref refs/remotes/origin/main "$main"

expect_failure() {
  local name="$1" message="$2" candidate="$3"
  if bash "$subject" --repo stella/stella --sha "$candidate" > "$fixture/output" 2> "$fixture/error"; then
    echo "FAIL $name accepted" >&2; exit 1
  fi
  grep -q "$message" "$fixture/error"
  [[ ! -s "$fixture/output" ]]
  echo "ok   $name"
}
expect_failure 'invalid SHA' 'full 40-character' main
for status in missing failure pending; do
  export TEST_STATUSES="[[{\"context\":\"staging/verified\",\"state\":\"$status\"}]]"
  expect_failure "$status status" "staging/verified = $status" "$TEST_CANDIDATE"
done
export TEST_STATUSES='[[{"context":"staging/verified","state":"failure"}],[{"context":"staging/verified","state":"success"}]]'
expect_failure 'new failure invalidates old success' 'staging/verified = failure' "$TEST_CANDIDATE"
export TEST_STATUSES='[[{"context":"staging/verified","state":"success"}]]'
# The tag needs success on both statuses on the exact commit, and the refusal
# names each status that is not green.
for state in failure pending; do
  reset_health
  TEST_HEAVY_STATUS=$(jq --arg state "$state" '.state=$state' <<< "$TEST_HEAVY_STATUS")
  expect_failure "heavy status $state" "RELEASE_STATUS_NOT_GREEN: .* main/heavy = $state" "$TEST_CANDIDATE"
done
reset_health
TEST_HEAVY_STATUS=$(jq '.context="other"' <<< "$TEST_HEAVY_STATUS")
expect_failure 'heavy status missing' 'RELEASE_STATUS_NOT_GREEN: .* main/heavy = missing' "$TEST_CANDIDATE"
export TEST_STATUSES='[[]]'
expect_failure 'both statuses missing' 'staging/verified = missing, main/heavy = missing' "$TEST_CANDIDATE"
export TEST_STATUSES='[[{"context":"staging/verified","state":"success"}]]'
# Each metadata dimension independently invalidates otherwise green evidence.
for expression in '.creator.login="other"' '.creator.type="User"' '.target_url="https://github.com/other/repo/actions/runs/7"'; do
  reset_health
  TEST_HEAVY_STATUS=$(jq "$expression" <<< "$TEST_HEAVY_STATUS")
  expect_failure "heavy status $expression" 'RELEASE_HEAVY_NOT_GREEN' "$TEST_CANDIDATE"
done
for expression in '.id=8' '.html_url="other"' '.repository.full_name="other/repo"' '.path=".github/workflows/other.yml"' '.head_branch="other"' '.event="pull_request"' '.display_title += " suffix"' '.head_sha="0000000000000000000000000000000000000000"' '.status="in_progress"' '.conclusion="failure"' '.conclusion="skipped"' '.conclusion="neutral"' '.conclusion="timed_out"'; do
  reset_health
  TEST_HEAVY_RUN=$(jq "$expression" <<< "$TEST_HEAVY_RUN")
  expect_failure "heavy run $expression" 'RELEASE_HEAVY_NOT_GREEN' "$TEST_CANDIDATE"
done
reset_health
export TEST_COMPARISON='{"status":"diverged","merge_base_commit":{"sha":"other"}}'
expect_failure 'heavy candidate ancestry' 'RELEASE_HEAVY_NOT_GREEN' "$TEST_CANDIDATE"
reset_health
export TEST_INCIDENTS='[[],[{"number":1}]]'
expect_failure 'open incident on later page' 'RELEASE_OPEN_MAIN_INCIDENT' "$TEST_CANDIDATE"
for endpoint in "--paginate --slurp repos/stella/stella/commits/$TEST_CANDIDATE/statuses?per_page=100" 'repos/stella/stella/actions/runs/7' "repos/stella/stella/compare/$TEST_CANDIDATE...main" '--paginate --slurp repos/stella/stella/issues?state=open&labels=main-health-incident&per_page=100'; do
  reset_health
  export TEST_API_ERROR="api $endpoint"
  expect_failure "API failure $endpoint" 'GitHub command failed: HTTP 0, attempt 1/4 (exit 1)' "$TEST_CANDIDATE"
done
reset_health
TEST_STATUSES=$(jq --argjson old "$TEST_HEAVY_STATUS" '.[0] += [($old | .state="failure"), $old]' <<< "$TEST_STATUSES")
expect_failure 'new heavy failure invalidates old success' 'main/heavy = failure' "$TEST_CANDIDATE"
export TEST_STATUSES='[[{"context":"staging/verified","state":"success"}]]'
reset_health
# Dispatch may test an older main SHA; the title binds the tested SHA.
TEST_HEAVY_RUN=$(jq '.event="workflow_dispatch" | .head_sha="0000000000000000000000000000000000000000"' <<< "$TEST_HEAVY_RUN")
bash "$subject" --repo stella/stella --sha "$TEST_CANDIDATE" > "$fixture/output"
reset_health
git tag v1.2.3 "$TEST_CANDIDATE"
expect_failure 'existing tag' 'already exists' "$TEST_CANDIDATE"
git tag -d v1.2.3 >/dev/null
printf '1.2.4\n' > VERSION
git add VERSION
git commit -qm bump
git update-ref refs/remotes/origin/main HEAD
expect_failure 'VERSION mismatch' 'does not match pending VERSION' "$TEST_CANDIDATE"
git update-ref refs/remotes/origin/main "$main"
expect_failure 'wrong ancestry' 'not an ancestor' "$(git rev-parse HEAD)"
git checkout -q --detach "$main"
output=$(bash "$subject" --repo stella/stella --sha "$TEST_CANDIDATE")
[[ "$output" == "$(printf 'sha=%s\nvalue=1.2.3\ntag=v1.2.3' "$TEST_CANDIDATE")" ]]
[[ "$(bash "$subject" --repo stella/stella)" == "$output" ]]
echo 'ok   explicit candidate and newest verified default'
# A newer commit verified on staging but not heavy-green is passed over.
export TEST_LATER="$main" TEST_LATER_STATUSES='[[{"context":"staging/verified","state":"success"}]]'
[[ "$(bash "$subject" --repo stella/stella)" == "$output" ]]
export TEST_LATER_STATUSES='[[{"context":"main/heavy","state":"success"}]]'
[[ "$(bash "$subject" --repo stella/stella)" == "$output" ]]
unset TEST_LATER TEST_LATER_STATUSES
echo 'ok   default skips a newer commit missing either status'
# Execute the real workflow tag block against a local remote; HEAD is newer.
git init --bare -q "$fixture/remote"
export TEST_REMOTE="$fixture/remote"
TEST_REAL_GIT=$(command -v git)
cat > "$fixture/bin/git" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == push ]]; then
  exec "$TEST_REAL_GIT" push "$TEST_REMOTE" "$3"
fi
exec "$TEST_REAL_GIT" "$@"
STUB
chmod +x "$fixture/bin/git"
export RUNNER_TEMP="$fixture" RELEASE_HEALTH_TOKEN=fixture
export GH_RETRY_SCRIPT="$script_dir/gh-retry.sh"
cp "$script_dir/check-release-main-health.sh" "$RUNNER_TEMP/check-release-main-health.sh"
export TAG=v1.2.3 RELEASE_SHA="$TEST_CANDIDATE" GH_TOKEN=fixture GITHUB_REPOSITORY=stella/stella
# The run block ends at the first line outside its indentation; later jobs are
# YAML, not shell.
awk '/GH_TOKEN=.*bash.*check-release-main-health/ { block = 1 }
  block && !/^          / { exit }
  block { sub(/^          /, ""); print }' "$workflow" > "$fixture/push.sh"
[[ -s "$fixture/push.sh" ]]
grep -q '^git push ' "$fixture/push.sh"
export TEST_INCIDENTS='[[{"number":1}]]'
if bash -e "$fixture/push.sh" > "$fixture/output" 2> "$fixture/error"; then
  echo 'FAIL incident appeared before tag push' >&2; exit 1
fi
grep -q RELEASE_OPEN_MAIN_INCIDENT "$fixture/error"
if "$TEST_REAL_GIT" show-ref --verify --quiet refs/tags/v1.2.3; then
  echo "FAIL unexpected release tag" >&2
  exit 1
fi
if "$TEST_REAL_GIT" --git-dir="$fixture/remote" show-ref --verify --quiet refs/tags/v1.2.3; then
  echo "FAIL unexpected release tag" >&2
  exit 1
fi
# Either status turning red after selection stops the push.
reset_health
bash "$subject" --repo stella/stella --sha "$TEST_CANDIDATE" > "$fixture/output"
export TEST_STATUSES='[[{"context":"staging/verified","state":"failure"},{"context":"staging/verified","state":"success"}]]'
if bash -e "$fixture/push.sh" > "$fixture/output" 2> "$fixture/error"; then
  echo 'FAIL staging/verified failed before tag push' >&2; exit 1
fi
grep -q 'RELEASE_STATUS_NOT_GREEN: staging/verified = failure' "$fixture/error"
if "$TEST_REAL_GIT" --git-dir="$fixture/remote" show-ref --verify --quiet refs/tags/v1.2.3; then
  echo "FAIL unexpected release tag" >&2
  exit 1
fi
export TEST_STATUSES='[[{"context":"staging/verified","state":"success"}]]'
TEST_HEAVY_STATUS=$(jq '.state="failure"' <<< "$TEST_HEAVY_STATUS")
if bash -e "$fixture/push.sh" > "$fixture/output" 2> "$fixture/error"; then
  echo 'FAIL main/heavy failed before tag push' >&2; exit 1
fi
grep -q 'RELEASE_HEAVY_NOT_GREEN' "$fixture/error"
if "$TEST_REAL_GIT" show-ref --verify --quiet refs/tags/v1.2.3; then
  echo "FAIL unexpected release tag" >&2
  exit 1
fi
if "$TEST_REAL_GIT" --git-dir="$fixture/remote" show-ref --verify --quiet refs/tags/v1.2.3; then
  echo "FAIL unexpected release tag" >&2
  exit 1
fi
echo 'ok   push re-checks both statuses'
reset_health
bash -e "$fixture/push.sh"
[[ "$(git --git-dir="$fixture/remote" rev-parse 'refs/tags/v1.2.3^{}')" == "$TEST_CANDIDATE" ]]
echo 'ok   workflow tags exactly the candidate rather than HEAD'
git tag -d v1.2.3 >/dev/null
printf '%s\n' '---' '"@stll/example": patch' '---' 'Pending note' > .changeset/pending.md
git add .changeset/pending.md
git commit -qm changeset
TEST_CANDIDATE=$(git rev-parse HEAD)
git update-ref refs/remotes/origin/main HEAD
reset_health
bash "$subject" --repo stella/stella --sha "$TEST_CANDIDATE" > "$fixture/output" 2> "$fixture/error"
grep -q '::warning::.*unconsumed changesets' "$fixture/error"
echo 'ok   unconsumed changesets warn without refusing'
