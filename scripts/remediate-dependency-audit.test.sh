#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
subject="$script_dir/remediate-dependency-audit.sh"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/bin" "$fixture/repo"
cat > "$fixture/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\n' "$*" >> "$TEST_CALLS"
case "$1 $2" in
  "pr list") printf '%s\n' "${TEST_OPEN_PRS:-0}" ;;
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
if [[ "$*" == "--no-env-file scripts/dependency-audit.ts --prepare-remediation" ]]; then
  if [[ "${TEST_FIX_AVAILABLE:-false}" == true ]]; then
    echo pinned > package.json
  fi
  if [[ "${TEST_QUARANTINED:-false}" == true ]]; then
    echo excluded > bunfig.toml
    echo pinned > package.json
  fi
  if [[ "${TEST_UPSTREAM_BLOCKED:-false}" == true ]]; then
    echo drafted > scripts/dependency-audit-baseline.json
  fi
  if [[ "${TEST_STALE:-false}" == true ]]; then
    echo pruned > scripts/dependency-audit-baseline.json
  fi
  exit 0
fi
if [[ "$*" == "--no-env-file install --lockfile-only" ]]; then
  if [[ "${TEST_FIX_AVAILABLE:-false}${TEST_QUARANTINED:-false}" == *true* ]]; then
    echo updated > bun.lock
  fi
  exit 0
fi
if [[ "$*" == "--no-env-file scripts/dependency-audit.ts --prune-baseline" ]]; then
  exit 0
fi
exit 2
STUB
chmod +x "$fixture/bin/gh" "$fixture/bin/bun"
export PATH="$fixture/bin:$PATH" TEST_CALLS="$fixture/calls" GITHUB_OUTPUT="$fixture/outputs"
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
touch bun.lock bunfig.toml
mkdir scripts
echo baseline > scripts/dependency-audit-baseline.json
mkdir -p apps/web
echo root > package.json
echo pinned > apps/web/package.json
git add bun.lock bunfig.toml scripts/dependency-audit-baseline.json package.json apps/web/package.json
git commit -qm initial
initial_sha="$(git rev-parse HEAD)"
TEST_OPEN_PRS=1 TEST_FIX_AVAILABLE=true bash "$subject"
grep -q '^changed=true$' "$GITHUB_OUTPUT"
[[ "$(grep -Ec '^bun .* --assess$' "$TEST_CALLS")" == 1 ]]
[[ "$(grep -Ec '^bun .* --prepare-remediation$' "$TEST_CALLS")" == 1 ]]
refute_call '^git push |^gh pr create |^gh pr list '
: > "$TEST_CALLS"
: > "$GITHUB_OUTPUT"
git restore bun.lock bunfig.toml scripts/dependency-audit-baseline.json package.json apps/web/package.json
if TEST_ASSESS_STATUS=3 bash "$subject"; then
  echo 'An assessment failure must stop remediation.' >&2
  exit 1
fi
refute_call '^git push |^gh pr create '
: > "$TEST_CALLS"
: > "$GITHUB_OUTPUT"
for scenario in TEST_FIX_AVAILABLE TEST_QUARANTINED TEST_UPSTREAM_BLOCKED TEST_STALE; do
  git restore bun.lock bunfig.toml scripts/dependency-audit-baseline.json package.json apps/web/package.json
  : > "$TEST_CALLS"
  : > "$GITHUB_OUTPUT"
  env "$scenario=true" TEST_OPEN_PRS=1 bash "$subject"
  grep -q '^changed=true$' "$GITHUB_OUTPUT"
  [[ "$(grep -Ec '^bun ' "$TEST_CALLS")" == 4 ]]
  refute_call '^gh pr list |^gh pr create |^git push '
  [[ "$(git rev-parse HEAD)" == "$initial_sha" ]]
done
[[ "$(cat scripts/dependency-audit-baseline.json)" == baseline || "$(cat scripts/dependency-audit-baseline.json)" == pruned ]]
echo 'ok  remediation refreshes existing branches and plans every disposition'
