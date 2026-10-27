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
touch bun.lock
mkdir scripts
echo baseline > scripts/dependency-audit-baseline.json
mkdir -p apps/web
echo root > package.json
echo pinned > apps/web/package.json
git add bun.lock scripts/dependency-audit-baseline.json package.json apps/web/package.json
git commit -qm initial
TEST_OPEN_PRS=1 bash "$subject"
grep -q '^changed=false$' "$GITHUB_OUTPUT"
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
if grep -q '^changed=true$' "$GITHUB_OUTPUT"; then
  echo 'No change must leave publication disabled.' >&2
  exit 1
fi
[[ "$(grep -Ec '^bun ' "$TEST_CALLS")" == 3 ]]
refute_call '^gh issue |^git push |^gh pr create '
: > "$TEST_CALLS"
for scenario in TEST_FIX_AVAILABLE TEST_STALE TEST_PIN_REWRITE; do
  git restore bun.lock scripts/dependency-audit-baseline.json apps/web/package.json
  : > "$TEST_CALLS"
  : > "$GITHUB_OUTPUT"
  env "$scenario=true" TEST_OPEN_PRS=0 TEST_ADVISORIES_REMAIN=true bash "$subject"
  grep -q '^changed=true$' "$GITHUB_OUTPUT"
  [[ "$(grep -Ec '^bun ' "$TEST_CALLS")" == 3 ]]
  refute_call '^gh pr create '
  [[ "$(git log --oneline | wc -l | tr -d ' ')" == 1 ]]
done
[[ "$(cat apps/web/package.json)" == rewritten ]]
[[ "$(cat bun.lock)" == updated ]]
echo 'ok  remediation assesses before deduplication and prepares changes for signed commits'
