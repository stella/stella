#!/usr/bin/env bash
set -euo pipefail
subject="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/remediate-dependency-audit.sh"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/bin" "$fixture/repo"
cat > "$fixture/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\n' "$*" >> "$TEST_CALLS"
case "$1 $2" in
  "pr list") printf '%s\n' "${TEST_OPEN_PRS:-0}" ;;
  "issue list") printf '%s\n' "${TEST_OPEN_ISSUES:-0}" ;;
  *) ;;
esac
STUB
cat > "$fixture/bin/bun" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'bun %s\n' "$*" >> "$TEST_CALLS"
STUB
chmod +x "$fixture/bin/gh" "$fixture/bin/bun"
export PATH="$fixture/bin:$PATH" TEST_CALLS="$fixture/calls"
cd "$fixture/repo"
git init -q
git config user.name test
git config user.email test@example.com
touch bun.lock
git add bun.lock
git commit -qm initial

TEST_OPEN_PRS=1 TEST_OPEN_ISSUES=0 bash "$subject"
! grep -q '^bun ' "$TEST_CALLS"
: > "$TEST_CALLS"
TEST_OPEN_PRS=0 TEST_OPEN_ISSUES=1 bash "$subject"
! grep -q '^bun ' "$TEST_CALLS"
: > "$TEST_CALLS"
TEST_OPEN_PRS=0 TEST_OPEN_ISSUES=0 bash "$subject"
[[ "$(grep -c '^gh issue create ' "$TEST_CALLS")" == 1 ]]
[[ "$(grep -c '^bun ' "$TEST_CALLS")" == 1 ]]
echo 'ok   remediation identities deduplicate pull requests and issues'
