#!/usr/bin/env bash
set -euo pipefail
subject="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/remediate-dependency-audit.sh"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/bin" "$fixture/repo"
export TEST_REAL_GIT="$(command -v git)"
cat > "$fixture/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\n' "$*" >> "$TEST_CALLS"
case "$1 $2" in
  "pr list") printf '%s\n' "${TEST_OPEN_PRS:-0}" ;;
  "pr create")
    [[ "$("$TEST_REAL_GIT" --git-dir="$TEST_REMOTE" rev-parse refs/heads/automation/dependency-audit-fix)" == "$("$TEST_REAL_GIT" rev-parse HEAD)" ]]
    ;;
  *) exit 1 ;;
esac
STUB
cat > "$fixture/bin/bun" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'bun %s\n' "$*" >> "$TEST_CALLS"
if [[ "${TEST_FIX_AVAILABLE:-false}" == true ]]; then
  echo updated >> bun.lock
fi
STUB
cat > "$fixture/bin/git" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
helpers=()
while [[ "${1:-}" == -c ]]; do
  helpers+=("$2")
  shift 2
done
if [[ "${1:-}" == push || "${1:-}" == fetch || "${1:-}" == ls-remote ]]; then
  [[ "${helpers[*]-}" == 'credential.helper= credential.helper=!gh auth git-credential' ]] || {
    echo 'Remote operations require the gh credential helper.' >&2
    exit 1
  }
fi
if [[ "${1:-}" == push ]]; then
  printf 'git push %s\n' "$*" >> "$TEST_CALLS"
  if [[ -n "${TEST_CONCURRENT_SHA:-}" ]]; then
    "$TEST_REAL_GIT" --git-dir="$TEST_REMOTE" update-ref refs/heads/automation/dependency-audit-fix "$TEST_CONCURRENT_SHA"
  fi
fi
exec "$TEST_REAL_GIT" "${args[@]}"
STUB
chmod +x "$fixture/bin/gh" "$fixture/bin/bun" "$fixture/bin/git"
export PATH="$fixture/bin:$PATH" TEST_CALLS="$fixture/calls" TEST_REMOTE="$fixture/remote.git"
cd "$fixture/repo"
git init -q
git config user.name test
git config user.email test@example.com
git config commit.gpgsign false
touch bun.lock
git add bun.lock
git commit -qm initial
initial_sha="$(git rev-parse HEAD)"
git init --bare -q "$TEST_REMOTE"
git remote add origin "$TEST_REMOTE"

TEST_OPEN_PRS=1 bash "$subject"
! rg -q '^bun |^git push |^gh pr create ' "$TEST_CALLS"
: > "$TEST_CALLS"
TEST_OPEN_PRS=0 bash "$subject"
[[ "$(rg -c '^bun ' "$TEST_CALLS")" == 1 ]]
! rg -q '^gh issue |^git push |^gh pr create ' "$TEST_CALLS"
: > "$TEST_CALLS"
TEST_OPEN_PRS=0 TEST_FIX_AVAILABLE=true bash "$subject"
[[ "$(rg -c '^git push ' "$TEST_CALLS")" == 1 ]]
[[ "$(rg -c '^gh pr create ' "$TEST_CALLS")" == 1 ]]
[[ "$(git --git-dir="$TEST_REMOTE" show refs/heads/automation/dependency-audit-fix:bun.lock)" == updated ]]
! rg -q '^gh issue ' "$TEST_CALLS"

# Match a source-only checkout with an abandoned remote remediation branch.
git commit --allow-empty -qm 'abandoned remediation'
git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin automation/dependency-audit-fix
git checkout --detach "$initial_sha"
git update-ref -d refs/remotes/origin/automation/dependency-audit-fix
! git show-ref --verify --quiet refs/remotes/origin/automation/dependency-audit-fix
: > "$TEST_CALLS"
TEST_OPEN_PRS=0 TEST_FIX_AVAILABLE=true bash "$subject"
[[ "$(rg -c '^git push ' "$TEST_CALLS")" == 1 ]]
[[ "$(rg -c '^gh pr create ' "$TEST_CALLS")" == 1 ]]
[[ "$(git --git-dir="$TEST_REMOTE" show refs/heads/automation/dependency-audit-fix:bun.lock)" == updated ]]

# A remote update after observation must survive a rejected lease.
git checkout --detach "$initial_sha"
git update-ref -d refs/remotes/origin/automation/dependency-audit-fix
: > "$TEST_CALLS"
if TEST_OPEN_PRS=0 TEST_FIX_AVAILABLE=true TEST_CONCURRENT_SHA="$initial_sha" bash "$subject"; then
  echo 'A concurrent remote update must reject the push.' >&2
  exit 1
fi
[[ "$(git --git-dir="$TEST_REMOTE" rev-parse refs/heads/automation/dependency-audit-fix)" == "$initial_sha" ]]
! rg -q '^gh pr create ' "$TEST_CALLS"
echo 'ok   remediation deduplicates pull requests, authenticates remote operations and leases existing branches safely'
