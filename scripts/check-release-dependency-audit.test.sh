#!/usr/bin/env bash
set -euo pipefail
subject="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-release-dependency-audit.sh"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/bin"
cat > "$fixture/bin/bun" <<'STUB'
#!/usr/bin/env bash
exit "${TEST_AUDIT_STATUS:?}"
STUB
chmod +x "$fixture/bin/bun"
export PATH="$fixture/bin:$PATH"

TEST_AUDIT_STATUS=0 WAIVE_DEPENDENCY_AUDIT=false WAIVER_REASON= bash "$subject"
if TEST_AUDIT_STATUS=1 WAIVE_DEPENDENCY_AUDIT=false WAIVER_REASON= bash "$subject"; then
  echo 'FAIL advisory accepted without waiver' >&2; exit 1
fi
TEST_AUDIT_STATUS=1 WAIVE_DEPENDENCY_AUDIT=true WAIVER_REASON='Reviewed for this release' bash "$subject"
if TEST_AUDIT_STATUS=1 WAIVE_DEPENDENCY_AUDIT=true WAIVER_REASON=' ' bash "$subject"; then
  echo 'FAIL empty waiver reason accepted' >&2; exit 1
fi
if TEST_AUDIT_STATUS=0 WAIVE_DEPENDENCY_AUDIT=true WAIVER_REASON='Unused waiver' bash "$subject"; then
  echo 'FAIL unused waiver accepted' >&2; exit 1
fi
echo 'ok   release audit refuses findings and accepts only a reasoned waiver'
