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
if [[ "$*" != *"/commits/$TEST_CANDIDATE/statuses?per_page=100"* ]]; then
  echo '[[]]'
else
  printf '%s\n' "$TEST_STATUSES"
fi
STUB
cat > "$fixture/bin/bun" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" != 5 || "$1" != "$TEST_HEALTH_SCRIPT" || "$2" != --release-guard || "$3" != "$TEST_CANDIDATE" || "$4" != --repo || "$5" != stella/stella ]]; then
  echo 'Unexpected main-health release guard arguments' >&2
  exit 1
fi
if [[ "$TEST_HEALTH_OK" != true ]]; then
  echo 'main-health release guard refused' >&2
  exit 1
fi
STUB
chmod +x "$fixture/bin/gh" "$fixture/bin/bun"
export PATH="$fixture/bin:$PATH"
export TEST_HEALTH_SCRIPT="$script_dir/main-health.ts" TEST_HEALTH_OK=true
export TEST_STATUSES='[[{"context":"staging/verified","state":"success"}]]'
git init -q "$fixture/repo"
cd "$fixture/repo"
git config user.name test
git config user.email test@example.com
git config commit.gpgsign false
printf '1.2.3\n' > VERSION
mkdir .changeset
printf '# Changesets\n' > .changeset/README.md
git add .
git commit -qm candidate
export TEST_CANDIDATE=$(git rev-parse HEAD)
git commit --allow-empty -qm later
main=$(git rev-parse HEAD)
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
export TEST_HEALTH_OK=false
expect_failure 'main health refusal' 'main-health release guard refused' "$TEST_CANDIDATE"
export TEST_HEALTH_OK=true
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
# Execute the real workflow tag block against a local remote; HEAD is newer.
git init --bare -q "$fixture/remote"
export TEST_REMOTE="$fixture/remote"
export TEST_REAL_GIT=$(command -v git)
cat > "$fixture/bin/git" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == push ]]; then
  exec "$TEST_REAL_GIT" push "$TEST_REMOTE" "$3"
fi
exec "$TEST_REAL_GIT" "$@"
STUB
chmod +x "$fixture/bin/git"
export TAG=v1.2.3 RELEASE_SHA="$TEST_CANDIDATE" GH_TOKEN=fixture GITHUB_REPOSITORY=stella/stella
sed -n '/^          git config user.name/,$p' "$workflow" | sed 's/^          //' > "$fixture/push.sh"
bash "$fixture/push.sh"
[[ "$(git --git-dir="$fixture/remote" rev-parse 'refs/tags/v1.2.3^{}')" == "$TEST_CANDIDATE" ]]
echo 'ok   workflow tags exactly the candidate rather than HEAD'
git tag -d v1.2.3 >/dev/null
printf '%s\n' '---' '"@stll/example": patch' '---' 'Pending note' > .changeset/pending.md
git add .changeset/pending.md
git commit -qm changeset
export TEST_CANDIDATE=$(git rev-parse HEAD)
git update-ref refs/remotes/origin/main HEAD
bash "$subject" --repo stella/stella --sha "$TEST_CANDIDATE" > "$fixture/output" 2> "$fixture/error"
grep -q '::warning::.*unconsumed changesets' "$fixture/error"
echo 'ok   unconsumed changesets warn without refusing'
