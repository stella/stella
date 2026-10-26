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
  *"/commits/$TEST_CANDIDATE/check-runs?check_name=ci-result&filter=all&per_page=100"*) printf '%s\n' "$TEST_CHECK_RUNS" ;;
  *"/check-runs?"*) echo '[{"total_count":0,"check_runs":[]}]' ;;
  *"/commits/$TEST_CANDIDATE/statuses?per_page=100"*)
    jq --argjson heavy "$TEST_HEAVY_STATUS" --argjson depth "$TEST_PR_DEPTH_STATUS" '.[0] += [$heavy, $depth]' <<< "$TEST_STATUSES" ;;
  *"/commits/${TEST_LATER:-none}/statuses?per_page=100"*) printf '%s\n' "$TEST_LATER_STATUSES" ;;
  *"/statuses?per_page=100"*) echo '[[]]' ;;
  # The release queue history check reads single pages, never --slurp.
  "api repos/stella/stella/commits/$TEST_CANDIDATE/pulls?per_page=100") printf '%s\n' "$TEST_CANDIDATE_PULLS" ;;
  *"query="*"ReleaseCommitHistory"*)
    jq -nc \
      --arg sha "$TEST_CANDIDATE" \
      --argjson pulls "$TEST_CANDIDATE_PULLS" \
      --argjson timeline "$TEST_TIMELINE" \
      --argjson runs "$TEST_MG_RUNS" '
      {
        data: {
          repository: {
            c0: {
              oid: $sha,
              associatedPullRequests: {
                pageInfo: {hasNextPage: false},
                nodes: ($pulls | map({
                  number,
                  title,
                  url: .html_url,
                  mergedAt: .merged_at,
                  mergeCommit: {oid: .merge_commit_sha},
                  timelineItems: $timeline.data.repository.pullRequest.timelineItems
                }))
              },
              checkSuites: {
                pageInfo: {hasNextPage: false, endCursor: null},
                nodes: ($runs.workflow_runs | map({
                  conclusion: (if .conclusion == "success" then "SUCCESS" else (.conclusion | ascii_upcase) end),
                  workflowRun: {event, file: {path: ".github/workflows/ci.yml"}}
                }))
              }
            }
          }
        }
      }' ;;
  "api graphql "*"number=1") printf '%s\n' "$TEST_TIMELINE" ;;
  *"/actions/workflows/ci.yml/runs?head_sha=$TEST_CANDIDATE&event=merge_group&"*) printf '%s\n' "$TEST_MG_RUNS" ;;
  *"/actions/workflows/ci.yml/runs?"*) echo '{"workflow_runs":[]}' ;;
  *"/pulls?per_page=100"*) echo '[[]]' ;;
  *"/commits/"*)
    commit="${!#}"
    commit="${commit##*/}"
    tree=$(git rev-parse "$commit^{tree}")
    jq -nc --arg sha "$commit" --arg tree "$tree" '{sha:$sha,commit:{tree:{sha:$tree}}}' ;;
  *"/actions/runs/7"*) printf '%s\n' "$TEST_HEAVY_RUN" ;;
  *"/actions/runs/9"*) printf '%s\n' "$TEST_PR_DEPTH_RUN" ;;
  *"/actions/runs/5"*) printf '%s\n' "$TEST_MG_RUN" ;;
  *"/actions/jobs/6"*) printf '%s\n' "$TEST_MG_JOB" ;;
  *"/compare/$TEST_CANDIDATE...main"*) printf '%s\n' "$TEST_COMPARISON" ;;
  *"/issues?"*) printf '%s\n' "$TEST_INCIDENTS" ;;
  *) echo "unexpected API request: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$fixture/bin/gh"
export PATH="$fixture/bin:$PATH"
export TEST_CANDIDATE_PULLS TEST_TIMELINE TEST_MG_RUNS
export TEST_CANDIDATE TEST_CHECK_RUNS TEST_MG_RUN TEST_MG_JOB TEST_HEAVY_RUN TEST_COMPARISON TEST_HEAVY_STATUS TEST_PR_DEPTH_STATUS TEST_PR_DEPTH_RUN TEST_STATUSES TEST_REAL_GIT
export TEST_STATUSES='[[{"context":"staging/verified","state":"success"}]]'
git init -q "$fixture/repo"
cd "$fixture/repo"
git config user.name test
git config user.email test@example.com
git config commit.gpgsign false
git config tag.gpgsign false
# The previous release; queue history is read from its tag to the candidate.
printf '1.2.2\n' > VERSION
git add VERSION
git commit -qm 'previous release'
git tag v1.2.2
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
  export TEST_PR_DEPTH_STATUS='{"context":"main/pr-depth","state":"success","creator":{"login":"github-actions[bot]","type":"Bot"},"target_url":"https://github.com/stella/stella/actions/runs/9"}'
  TEST_PR_DEPTH_RUN=$(jq -nc --arg sha "$TEST_CANDIDATE" '{id:9,html_url:"https://github.com/stella/stella/actions/runs/9",repository:{full_name:"stella/stella"},path:".github/workflows/main-pr-depth.yml",head_branch:"main",event:"schedule",display_title:("Main PR-depth checks " + $sha),head_sha:$sha,status:"completed",conclusion:"success"}')
  TEST_COMPARISON=$(jq -nc --arg sha "$TEST_CANDIDATE" '{status:"ahead",merge_base_commit:{sha:$sha}}')
  export TEST_INCIDENTS='[[]]' TEST_API_ERROR=''
  TEST_CHECK_RUNS='[{"total_count":0,"check_runs":[]}]'
  TEST_MG_RUN='{}' TEST_MG_JOB='{}' TEST_MG_RUNS='{"workflow_runs":[]}'
  TEST_CANDIDATE_PULLS=$(jq -nc --arg sha "$TEST_CANDIDATE" '[{html_url:"https://github.com/stella/stella/pull/1",merge_commit_sha:$sha,merged_at:"2026-01-01T00:00:00Z",number:1,title:"Candidate"}]')
  TEST_TIMELINE=$(queue_timeline AddedToMergeQueueEvent MergedEvent)
}
queue_timeline() {
  jq -nc '{data:{repository:{pullRequest:{timelineItems:{pageInfo:{hasPreviousPage:false},nodes:([$ARGS.positional[] | {__typename:.}])}}}}}' --args "$@"
}
# A merge-group ci-result receipt on the candidate itself. The run link names
# Actions job 6, whose check_run_url points at check run 4.
use_receipt() {
  TEST_MG_JOB=$(jq -nc --arg sha "$TEST_CANDIDATE" '{id:6,run_id:5,head_sha:$sha,check_run_url:"https://api.github.com/repos/stella/stella/check-runs/4"}')
  TEST_MG_RUN=$(jq -nc --arg sha "$TEST_CANDIDATE" '{id:5,repository:{full_name:"stella/stella"},path:".github/workflows/ci.yml",event:"merge_group",head_sha:$sha,head_branch:"gh-readonly-queue/main/pr-1-base",status:"completed",conclusion:"success",check_suite_id:3}')
  TEST_CHECK_RUNS=$(jq -nc --arg sha "$TEST_CANDIDATE" '[{total_count:1,check_runs:[{id:4,name:"ci-result",head_sha:$sha,status:"completed",conclusion:"success",app:{slug:"github-actions"},check_suite:{id:3},details_url:"https://github.com/stella/stella/actions/runs/5/job/6"}]}]')
  TEST_MG_RUNS=$(jq -nc --arg sha "$TEST_CANDIDATE" '{workflow_runs:[{head_sha:$sha,event:"merge_group",conclusion:"success"}]}')
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
for state in failure pending; do
  reset_health
  TEST_PR_DEPTH_STATUS=$(jq --arg state "$state" '.state=$state' <<< "$TEST_PR_DEPTH_STATUS")
  expect_failure "PR-depth status $state" "RELEASE_STATUS_NOT_GREEN: .* main/pr-depth = $state" "$TEST_CANDIDATE"
done
reset_health
TEST_PR_DEPTH_STATUS=$(jq '.context="other"' <<< "$TEST_PR_DEPTH_STATUS")
expect_failure 'PR-depth status missing' 'RELEASE_STATUS_NOT_GREEN: .* main/pr-depth = missing' "$TEST_CANDIDATE"
for expression in '.path=".github/workflows/main-heavy.yml"' '.display_title="Main heavy suites \(.head_sha)"' '.conclusion="failure"'; do
  reset_health
  TEST_PR_DEPTH_RUN=$(jq "$expression" <<< "$TEST_PR_DEPTH_RUN")
  expect_failure "PR-depth run $expression" 'RELEASE_PR_DEPTH_NOT_GREEN' "$TEST_CANDIDATE"
done
# A merge-group receipt on the candidate stands in for main/heavy and
# main/pr-depth; staging/verified stays required.
reset_health
TEST_HEAVY_STATUS=$(jq '.state="failure"' <<< "$TEST_HEAVY_STATUS")
TEST_PR_DEPTH_STATUS=$(jq '.context="other"' <<< "$TEST_PR_DEPTH_STATUS")
expect_failure 'red heavy without a receipt' 'main/heavy = failure, main/pr-depth = missing, merge-group receipt = missing' "$TEST_CANDIDATE"
use_receipt
bash "$subject" --repo stella/stella --sha "$TEST_CANDIDATE" > "$fixture/output"
grep -qx "sha=$TEST_CANDIDATE" "$fixture/output"
echo 'ok   merge-group receipt replaces both heavy statuses'
# The receipt covers only its own group: an admin merge since the previous
# tag, or history that cannot be read, keeps both heavy statuses required.
use_receipt
TEST_TIMELINE=$(queue_timeline MergedEvent)
expect_failure 'receipt with an admin merge since the previous tag' 'merge-group receipt = not covering unvalidated or unreadable queue history' "$TEST_CANDIDATE"
TEST_TIMELINE='not json'
expect_failure 'receipt with unreadable queue history' 'merge-group receipt = not covering unvalidated or unreadable queue history' "$TEST_CANDIDATE"
reset_health
use_receipt
TEST_TIMELINE=$(queue_timeline MergedEvent)
# Captured: the history check reports the admin merge as a workflow ::error::
# command, which would otherwise annotate this passing job as failed.
bash "$subject" --repo stella/stella --sha "$TEST_CANDIDATE" > "$fixture/output" 2> "$fixture/error"
grep -qx "sha=$TEST_CANDIDATE" "$fixture/output"
grep -q 'not validated through the merge queue' "$fixture/error"
echo 'ok   an admin merge still releases with green heavy statuses'
reset_health
TEST_HEAVY_STATUS=$(jq '.state="failure"' <<< "$TEST_HEAVY_STATUS")
TEST_PR_DEPTH_STATUS=$(jq '.context="other"' <<< "$TEST_PR_DEPTH_STATUS")
for expression in '.[0].check_runs[0].conclusion="failure"' '.[0].check_runs[0].conclusion="neutral"' '.[0].check_runs[0].conclusion="skipped"' '.[0].check_runs[0].app.slug="other"' '.[0].check_runs = []' '.[0].check_runs += [.[0].check_runs[0] | .conclusion="failure"]'; do
  use_receipt
  TEST_CHECK_RUNS=$(jq -c "$expression" <<< "$TEST_CHECK_RUNS")
  expect_failure "receipt $expression" 'merge-group receipt = missing' "$TEST_CANDIDATE"
done
for expression in '.event="pull_request"' '.event="push"' '.path=".github/workflows/other.yml"' '.conclusion="failure"' '.head_sha="0000000000000000000000000000000000000000"'; do
  use_receipt
  TEST_MG_RUN=$(jq -c "$expression" <<< "$TEST_MG_RUN")
  expect_failure "receipt run $expression" 'merge-group receipt = missing' "$TEST_CANDIDATE"
done
for expression in '.check_run_url="https://api.github.com/repos/stella/stella/check-runs/5"' '.run_id=7'; do
  use_receipt
  TEST_MG_JOB=$(jq -c "$expression" <<< "$TEST_MG_JOB")
  expect_failure "receipt job $expression" 'merge-group receipt = missing' "$TEST_CANDIDATE"
done
use_receipt
export TEST_STATUSES='[[{"context":"staging/verified","state":"failure"}]]'
expect_failure 'receipt without staging' 'staging/verified = failure' "$TEST_CANDIDATE"
export TEST_STATUSES='[[{"context":"staging/verified","state":"success"}]]'
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
echo 'ok   explicit candidate and version commit default'
# Even a fully green later main commit cannot replace the version commit.
export TEST_LATER="$main" TEST_LATER_STATUSES='[[{"context":"staging/verified","state":"success"},{"context":"main/heavy","state":"success"},{"context":"main/pr-depth","state":"success"}]]'
expect_failure 'green later main commit' "version commit $TEST_CANDIDATE" "$main"
[[ "$(bash "$subject" --repo stella/stella)" == "$output" ]]
# Selection never falls back to another green commit when the version commit is red.
export TEST_STATUSES='[[{"context":"staging/verified","state":"failure"}]]'
expect_failure 'default version commit is red' 'RELEASE_STATUS_NOT_GREEN' ''
export TEST_STATUSES='[[{"context":"staging/verified","state":"success"}]]'
unset TEST_LATER TEST_LATER_STATUSES
echo 'ok   only the version commit can be selected, regardless of later gates'
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
cp "$script_dir/verify-release-tree-proof.sh" "$RUNNER_TEMP/verify-release-tree-proof.sh"
cp "$script_dir/check-release-receipt-coverage.sh" "$RUNNER_TEMP/check-release-receipt-coverage.sh"
cp "$script_dir/check-release-queue-history.ts" "$RUNNER_TEMP/check-release-queue-history.ts"
export RELEASE_TREE_PROOF_VERIFIER="$RUNNER_TEMP/verify-release-tree-proof.sh" PROOF_SHA=""
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
reset_health
TEST_PR_DEPTH_STATUS=$(jq '.state="failure"' <<< "$TEST_PR_DEPTH_STATUS")
if bash -e "$fixture/push.sh" > "$fixture/output" 2> "$fixture/error"; then
  echo 'FAIL main/pr-depth failed before tag push' >&2; exit 1
fi
grep -q 'RELEASE_PR_DEPTH_NOT_GREEN' "$fixture/error"
if "$TEST_REAL_GIT" --git-dir="$fixture/remote" show-ref --verify --quiet refs/tags/v1.2.3; then
  echo "FAIL unexpected release tag" >&2
  exit 1
fi
echo 'ok   push re-checks every status'
reset_health
bash -e "$fixture/push.sh"
[[ "$(git --git-dir="$fixture/remote" rev-parse 'refs/tags/v1.2.3^{}')" == "$TEST_CANDIDATE" ]]
echo 'ok   workflow tags exactly the candidate rather than HEAD'
git tag -d v1.2.3 >/dev/null
git --git-dir="$fixture/remote" tag -d v1.2.3 >/dev/null
# With a receipt on the candidate, a red main/heavy no longer stops the push.
reset_health
use_receipt
TEST_HEAVY_STATUS=$(jq '.state="failure"' <<< "$TEST_HEAVY_STATUS")
bash -e "$fixture/push.sh"
[[ "$(git --git-dir="$fixture/remote" rev-parse 'refs/tags/v1.2.3^{}')" == "$TEST_CANDIDATE" ]]
echo 'ok   push accepts the merge-group receipt'
git tag -d v1.2.3 >/dev/null
git --git-dir="$fixture/remote" tag -d v1.2.3 >/dev/null
# The push re-applies the history rule: an admin merge since the previous tag
# turns the receipt back into a requirement for main/heavy.
TEST_TIMELINE=$(queue_timeline MergedEvent)
if bash -e "$fixture/push.sh" > "$fixture/output" 2> "$fixture/error"; then
  echo 'FAIL receipt over an admin merge pushed a tag' >&2; exit 1
fi
grep -q 'RELEASE_HEAVY_NOT_GREEN' "$fixture/error"
grep -q 'history since v1.2.2 is not validated through the merge queue' "$fixture/error"
if "$TEST_REAL_GIT" --git-dir="$fixture/remote" show-ref --verify --quiet refs/tags/v1.2.3; then
  echo "FAIL unexpected release tag" >&2
  exit 1
fi
echo 'ok   push re-checks the history behind the receipt'
printf '%s\n' '---' '"@stll/example": patch' '---' 'Pending note' > .changeset/pending.md
git add .changeset/pending.md
printf '1.2.4\n' > VERSION
git add VERSION
git commit -qm changeset
TEST_CANDIDATE=$(git rev-parse HEAD)
git update-ref refs/remotes/origin/main HEAD
reset_health
bash "$subject" --repo stella/stella --sha "$TEST_CANDIDATE" > "$fixture/output" 2> "$fixture/error"
grep -q '::warning::.*unconsumed changesets' "$fixture/error"
echo 'ok   unconsumed changesets warn without refusing'
