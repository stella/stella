#!/usr/bin/env bash
# Exercise the workflow's disarm and queue steps without GitHub writes.
set -euo pipefail
cd "$(dirname "$0")/.."
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/quarantine-prune-test.XXXXXX")"
trap 'rm -rf "$fixture_root"' EXIT
bun - > "$fixture_root/arm.sh" <<'EXTRACT'
const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/quarantine-prune.yml").text());
const stepNames = workflow.jobs.prune.steps.map(step => step.name);
const orderedSteps = [
  "Disarm existing removal proposal",
  "Open or update the removal PR",
  "Arm automatic removal",
];
const positions = orderedSteps.map(name => stepNames.indexOf(name));
if (positions.some(position => position === -1)) throw new Error("Missing removal proposal lifecycle step");
if (!positions.every((position, index) => index === 0 || positions[index - 1] < position)) {
  throw new Error("Removal proposal lifecycle steps are out of order");
}
if (positions.at(-1) !== stepNames.length - 1) throw new Error("Arm step must remain last");
const step = workflow.jobs.prune.steps.find(step => step.name === "Arm automatic removal");
if (step.if !== "steps.prune.outputs.changed == 'true'") throw new Error("Unchanged proposals must reach the arm step");
process.stdout.write(step.run);
EXTRACT
bun - > "$fixture_root/disarm.sh" <<'EXTRACT'
const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/quarantine-prune.yml").text());
const step = workflow.jobs.prune.steps.find(step => step.name === "Disarm existing removal proposal");
if (step.if !== "steps.prune.outputs.changed == 'true'") throw new Error("Changed proposals must be disarmed");
if (step.env.GH_TOKEN !== "${{ steps.app-token.outputs.token }}") throw new Error("Disarm must use the app token");
process.stdout.write(step.run);
EXTRACT
cat > "$fixture_root/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == 'pr list' ]]; then
  if [[ "$*" == 'pr list --repo stella/stella --state open --base main --head chore/prune-quarantine-excludes --json number,isCrossRepository,autoMergeRequest --jq map(select(.isCrossRepository == false and .autoMergeRequest != null))[0].number // empty' ]]; then
    echo disarm-list >> "$CALLS"
    printf '%s\n' "$ARMED_NUMBER"
    exit 0
  fi
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
if [[ "$*" == 'pr merge 42 --repo stella/stella --disable-auto' ]]; then
  echo disarm:42 >> "$CALLS"
  exit "$DISARM_STATUS"
fi
[[ "$*" == 'pr merge 42 --repo stella/stella --auto --match-head-commit 0123456789abcdef0123456789abcdef01234567' ]]
echo 'queue:42' >> "$CALLS"
exit "$QUEUE_STATUS"
STUB
chmod +x "$fixture_root/gh"
export PATH="$fixture_root:$PATH"
export CALLS="$fixture_root/calls" GITHUB_STEP_SUMMARY="$fixture_root/summary"
export GITHUB_REPOSITORY=stella/stella PRUNE_BRANCH=chore/prune-quarantine-excludes
export PR_NUMBER='' LOOKUP_NUMBER=42 QUEUE_STATUS=0 WRITTEN_HEAD=''
export VIEW_HEAD=0123456789abcdef0123456789abcdef01234567
export ARMED_NUMBER='' DISARM_STATUS=0

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
# An absent or unarmed proposal needs no mutation.
: > "$CALLS"
bash "$fixture_root/disarm.sh" > "$fixture_root/output"
assert_calls disarm-list
# An armed proposal is disabled before the workflow can refresh it.
ARMED_NUMBER=42
: > "$CALLS"
bash "$fixture_root/disarm.sh" > "$fixture_root/output"
assert_calls $'disarm-list\ndisarm:42'
# A real disable failure stops the workflow before refresh.
DISARM_STATUS=1
: > "$CALLS"
if bash "$fixture_root/disarm.sh" > "$fixture_root/output"; then
  echo 'FAIL auto-merge disable failure was accepted' >&2
  exit 1
fi
assert_calls $'disarm-list\ndisarm:42'
DISARM_STATUS=0
# A fresh action output avoids a redundant lookup.
PR_NUMBER=42
run_step
assert_calls $'view\nqueue:42'
# An unchanged proposal is looked up and armed.
PR_NUMBER=''
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
