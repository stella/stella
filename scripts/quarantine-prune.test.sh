#!/usr/bin/env bash
# Exercise the workflow's arm step without GitHub writes.
set -euo pipefail
cd "$(dirname "$0")/.."
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/quarantine-prune-test.XXXXXX")"
trap 'rm -rf "$fixture_root"' EXIT
bun - > "$fixture_root/arm.sh" <<'EXTRACT'
const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/quarantine-prune.yml").text());
const step = workflow.jobs.prune.steps.find(step => step.name === "Arm automatic removal");
if (step.if !== "steps.prune.outputs.changed == 'true'") throw new Error("Unchanged proposals must reach the arm step");
process.stdout.write(step.run);
EXTRACT
cat > "$fixture_root/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'pr list')
    [[ "$*" == 'pr list --repo stella/stella --state open --base main --head chore/prune-quarantine-excludes --json number --jq .[0].number // empty' ]]
    echo lookup >> "$CALLS"
    printf '%s\n' "$LOOKUP_NUMBER"
    ;;
  'pr view')
    [[ "$*" == "pr view 42 --repo stella/stella --json headRefOid --jq .headRefOid" ]]
    echo head >> "$CALLS"
    printf '%s\n' abc123
    ;;
  'pr merge')
    [[ "$*" == 'pr merge 42 --repo stella/stella --auto --squash --match-head-commit abc123' ]]
    echo merge >> "$CALLS"
    exit "$MERGE_STATUS"
    ;;
  *) exit 99 ;;
esac
STUB
chmod +x "$fixture_root/gh"
export PATH="$fixture_root:$PATH"
export CALLS="$fixture_root/calls" GITHUB_STEP_SUMMARY="$fixture_root/summary"
export GITHUB_REPOSITORY=stella/stella PRUNE_BRANCH=chore/prune-quarantine-excludes
export PR_NUMBER='' MERGE_HOLD='' LOOKUP_NUMBER=42 MERGE_STATUS=0

assert_calls() {
  [[ "$(cat "$CALLS")" == "$1" ]] || {
    echo "Unexpected calls: $(cat "$CALLS")" >&2
    exit 1
  }
}
run_step() {
  : > "$CALLS"
  : > "$GITHUB_STEP_SUMMARY"
  bash "$fixture_root/arm.sh" > "$fixture_root/output"
}
# A fresh action output avoids a redundant lookup.
PR_NUMBER=42
run_step
assert_calls $'head\nmerge'
# A held proposal remains untouched, then is armed on the unchanged next run.
PR_NUMBER=''
MERGE_HOLD=maintenance
run_step
assert_calls ''
MERGE_HOLD=''
run_step
assert_calls $'lookup\nhead\nmerge'
# A vanished proposal cannot pass an empty number to the gate.
LOOKUP_NUMBER=''
run_step
assert_calls lookup
[[ $(cat "$GITHUB_STEP_SUMMARY") == *'No open quarantine removal PR found'* ]]
# Queue refusal is visible without failing the scheduled job.
LOOKUP_NUMBER=42
MERGE_STATUS=1
run_step
assert_calls $'lookup\nhead\nmerge'
[[ $(cat "$GITHUB_STEP_SUMMARY") == *'Could not queue removal PR #42'* ]]
echo 'quarantine prune arm scenarios passed'
