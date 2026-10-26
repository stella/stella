#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
subject="$script_dir/remediate-dependency-audit.sh"
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
if [[ "$*" == "--no-env-file scripts/dependency-audit.ts --assess" ]]; then
  echo 'GHSA-new-pinned package pinned_resolution_blocked: lift package.json resolutions.package'
  exit "${TEST_ASSESS_STATUS:-0}"
fi
if [[ "$*" == "--no-env-file scripts/dependency-audit.ts --prune-baseline" ]]; then
  if [[ "${TEST_STALE:-false}" == true ]]; then
    echo pruned > scripts/dependency-audit-baseline.json
  fi
  exit 0
fi
[[ "$*" == "--no-env-file audit fix" ]] || exit 2
if [[ "${TEST_FIX_AVAILABLE:-false}" == true ]]; then
  echo updated >> bun.lock
fi
# Bun rewrites an exact pin in a workspace manifest when it fixes it.
if [[ "${TEST_PIN_REWRITE:-false}" == true ]]; then
  echo updated >> bun.lock
  echo rewritten > apps/web/package.json
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
mkdir scripts
echo baseline > scripts/dependency-audit-baseline.json
mkdir -p apps/web
echo root > package.json
echo pinned > apps/web/package.json
git add bun.lock scripts/dependency-audit-baseline.json package.json apps/web/package.json
git commit -qm initial
initial_sha="$(git rev-parse HEAD)"
git init --bare -q "$TEST_REMOTE"
git remote add origin "$TEST_REMOTE"

TEST_OPEN_PRS=1 bash "$subject"
[[ "$(grep -Ec '^bun .* --assess$' "$TEST_CALLS")" == 1 ]]
refute_call '^git push |^gh pr create '
: > "$TEST_CALLS"
if TEST_OPEN_PRS=1 TEST_ASSESS_STATUS=1 bash "$subject" > "$fixture/report"; then
  echo 'An open partial remediation must not hide an unresolved pinned advisory.' >&2
  exit 1
fi
grep -q 'GHSA-new-pinned.*pinned_resolution_blocked.*resolutions.package' "$fixture/report"
[[ "$(grep -Ec '^bun .* --assess$' "$TEST_CALLS")" == 1 ]]
refute_call '^git push |^gh pr create '
: > "$TEST_CALLS"
if TEST_OPEN_PRS=1 TEST_ASSESS_STATUS=3 bash "$subject"; then
  echo 'An assessment failure must stop remediation.' >&2
  exit 1
fi
refute_call '^gh pr list |^git push |^gh pr create '
: > "$TEST_CALLS"
TEST_OPEN_PRS=0 bash "$subject"
[[ "$(grep -Ec '^bun ' "$TEST_CALLS")" == 3 ]]
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

# A stale acceptance alone opens the pull request that removes it.
git checkout --detach "$initial_sha"
git --git-dir="$TEST_REMOTE" update-ref -d refs/heads/automation/dependency-audit-fix
git update-ref -d refs/remotes/origin/automation/dependency-audit-fix
: > "$TEST_CALLS"
TEST_OPEN_PRS=0 TEST_STALE=true bash "$subject"
[[ "$(grep -Ec '^gh pr create ' "$TEST_CALLS")" == 1 ]]
[[ "$(git --git-dir="$TEST_REMOTE" show refs/heads/automation/dependency-audit-fix:scripts/dependency-audit-baseline.json)" == pruned ]]
[[ -z "$(git --git-dir="$TEST_REMOTE" show refs/heads/automation/dependency-audit-fix:bun.lock)" ]]

# A fix that rewrites a pinned manifest carries the manifest with the lockfile.
git checkout --detach "$initial_sha"
git --git-dir="$TEST_REMOTE" update-ref -d refs/heads/automation/dependency-audit-fix
git update-ref -d refs/remotes/origin/automation/dependency-audit-fix
: > "$TEST_CALLS"
TEST_OPEN_PRS=0 TEST_PIN_REWRITE=true bash "$subject"
[[ "$(grep -Ec '^gh pr create ' "$TEST_CALLS")" == 1 ]]
[[ "$(git --git-dir="$TEST_REMOTE" show refs/heads/automation/dependency-audit-fix:apps/web/package.json)" == rewritten ]]
[[ "$(git --git-dir="$TEST_REMOTE" show refs/heads/automation/dependency-audit-fix:bun.lock)" == updated ]]
echo 'ok  remediation deduplicates pull requests, authenticates remote operations and leases existing branches safely'
