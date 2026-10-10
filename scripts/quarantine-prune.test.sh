#!/usr/bin/env bash
# Exercise the workflow's queue step without GitHub writes.
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
if [[ "$1 $2" == 'pr list' ]]; then
  [[ "$*" == 'pr list --repo stella/stella --state open --base main --head chore/prune-quarantine-excludes --json number --jq .[0].number // empty' ]]
  echo lookup >> "$CALLS"
  printf '%s\n' "$LOOKUP_NUMBER"
  exit 0
fi
if [[ "$1 $2" == 'pr view' ]]; then
  [[ "$*" == 'pr view 42 --repo stella/stella --json headRefOid --jq .headRefOid' ]]
  echo view >> "$CALLS"
  printf '%s\n' "$VIEW_HEAD"
  exit 0
fi
[[ "$*" == 'pr merge 42 --repo stella/stella --auto --match-head-commit 0123456789abcdef0123456789abcdef01234567' ]]
echo 'queue:42' >> "$CALLS"
exit "$QUEUE_STATUS"
STUB
chmod +x "$fixture_root/gh"
export PATH="$fixture_root:$PATH"
export CALLS="$fixture_root/calls" GITHUB_STEP_SUMMARY="$fixture_root/summary"
export GITHUB_REPOSITORY=stella/stella PRUNE_BRANCH=chore/prune-quarantine-excludes
export PR_NUMBER='' MERGE_HOLD='' LOOKUP_NUMBER=42 QUEUE_STATUS=0 WRITTEN_HEAD=''
export VIEW_HEAD=0123456789abcdef0123456789abcdef01234567

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
assert_calls $'view\nqueue:42'
# A held proposal remains untouched, then is armed on the unchanged next run.
PR_NUMBER=''
MERGE_HOLD=maintenance
run_step
assert_calls ''
MERGE_HOLD=''
run_step
assert_calls $'lookup\nview\nqueue:42'
# A vanished proposal cannot pass an empty number to the gate.
LOOKUP_NUMBER=''
run_step
assert_calls lookup
[[ $(cat "$GITHUB_STEP_SUMMARY") == *'No open quarantine removal PR found'* ]]
# Queue refusal is visible without failing the scheduled job.
LOOKUP_NUMBER=42
QUEUE_STATUS=1
run_step
assert_calls $'lookup\nview\nqueue:42'
[[ $(cat "$GITHUB_STEP_SUMMARY") == *'Could not enqueue removal PR #42'* ]]
# A push after this job wrote its commit is never queued.
QUEUE_STATUS=0
PR_NUMBER=42
WRITTEN_HEAD=fedcba9876543210fedcba9876543210fedcba98
run_step
assert_calls view
[[ $(cat "$GITHUB_STEP_SUMMARY") == *'moved past the commit this job wrote'* ]]
# The written head itself is queued.
WRITTEN_HEAD=$VIEW_HEAD
run_step
assert_calls $'view\nqueue:42'
# A failed or malformed lookup queues nothing.
WRITTEN_HEAD=''
VIEW_HEAD=''
if run_step; then echo 'FAIL empty head lookup was accepted' >&2; exit 1; fi
assert_calls view
echo 'quarantine prune queue scenarios passed'
