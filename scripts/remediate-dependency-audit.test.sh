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
[[ "$*" == "--no-env-file audit fix" ]] || exit 2
if [[ "${TEST_FIX_AVAILABLE:-false}" == true ]]; then
  echo updated >> bun.lock
fi
# Bun exits 1 while advisories remain, including after a partial fix.
[[ "${TEST_ADVISORIES_REMAIN:-false}" != true ]]
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
# `! command` never trips `set -e`, so refutations exit explicitly.
refute_call() {
  if grep -Eq "$1" "$TEST_CALLS"; then
    echo "Unexpected call matching: $1" >&2
    exit 1
  fi
}
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
refute_call '^bun |^git push |^gh pr create '
: > "$TEST_CALLS"
TEST_OPEN_PRS=0 bash "$subject"
[[ "$(grep -Ec '^bun ' "$TEST_CALLS")" == 1 ]]
refute_call '^gh issue |^git push |^gh pr create '
: > "$TEST_CALLS"
TEST_OPEN_PRS=0 TEST_FIX_AVAILABLE=true bash "$subject"
[[ "$(grep -Ec '^git push ' "$TEST_CALLS")" == 1 ]]
[[ "$(grep -Ec '^gh pr create ' "$TEST_CALLS")" == 1 ]]
[[ "$(git --git-dir="$TEST_REMOTE" show refs/heads/automation/dependency-audit-fix:bun.lock)" == updated ]]
refute_call '^gh issue '

# Match a source-only checkout with an abandoned remote remediation branch.
git commit --allow-empty -qm 'abandoned remediation'
git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin automation/dependency-audit-fix
git checkout --detach "$initial_sha"
git update-ref -d refs/remotes/origin/automation/dependency-audit-fix
if git show-ref --verify --quiet refs/remotes/origin/automation/dependency-audit-fix; then
  echo 'The remote-tracking remediation branch must be absent.' >&2
  exit 1
fi
: > "$TEST_CALLS"
TEST_OPEN_PRS=0 TEST_FIX_AVAILABLE=true bash "$subject"
[[ "$(grep -Ec '^git push ' "$TEST_CALLS")" == 1 ]]
[[ "$(grep -Ec '^gh pr create ' "$TEST_CALLS")" == 1 ]]
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
refute_call '^gh pr create '

# A partial fix still opens the pull request when advisories remain.
git checkout --detach "$initial_sha"
git --git-dir="$TEST_REMOTE" update-ref -d refs/heads/automation/dependency-audit-fix
git update-ref -d refs/remotes/origin/automation/dependency-audit-fix
: > "$TEST_CALLS"
TEST_OPEN_PRS=0 TEST_FIX_AVAILABLE=true TEST_ADVISORIES_REMAIN=true bash "$subject"
[[ "$(grep -Ec '^gh pr create ' "$TEST_CALLS")" == 1 ]]
[[ "$(git --git-dir="$TEST_REMOTE" show refs/heads/automation/dependency-audit-fix:bun.lock)" == updated ]]
echo 'ok   remediation deduplicates pull requests, authenticates remote operations and leases existing branches safely'
