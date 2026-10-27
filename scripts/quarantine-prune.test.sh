#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/quarantine-prune-test.XXXXXX")"
trap 'rm -rf "$fixture_root"' EXIT
bun - > "$fixture_root/workflow-check.ts" <<'CHECK'
const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/quarantine-prune.yml").text());
const steps = workflow.jobs.prune.steps;
const decision = steps.find((step) => step.name === "Decide removal proposal update");
const write = steps.find((step) => step.id === "removal-pr");
const arm = steps.find((step) => step.name === "Arm automatic removal");
if (decision.id !== "decision") throw new Error("Decision output must be addressable");
if (write.if !== "steps.decision.outputs.outcome == 'write'") throw new Error("Only write decisions may update the branch");
if (!write.with.paths.includes("**/bunfig.toml")) throw new Error("Nested bunfig.toml files must be committed");
if (!arm.if.includes("steps.decision.outputs.outcome != 'queued'")) throw new Error("Queued proposals must not be re-armed");
if (!arm.env.PR_NUMBER.includes("steps.decision.outputs.pull-request-number")) throw new Error("An unchanged proposal must retain its PR number");
if (!arm.env.WRITTEN_HEAD.includes("steps.decision.outputs.head")) throw new Error("An unchanged proposal must retain its head");
if (!steps.find((step) => step.id === "prune").run.includes("check-standalone-lockfiles.ts")) throw new Error("Standalone lockfiles must pass before a proposal");
CHECK
bun "$fixture_root/workflow-check.ts"
cat > "$fixture_root/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "pr list" ]]; then echo list >> "$CALLS"; printf '%s\n' "$PROPOSAL"; exit 0; fi
if [[ "$1 $2" == "pr diff" ]]; then echo diff >> "$CALLS"; cat "$EXISTING_PATCH"; exit 0; fi
exit 99
STUB
chmod +x "$fixture_root/gh"
export PATH="$fixture_root:$PATH" GITHUB_REPOSITORY=stella/stella PRUNE_BRANCH=chore/prune-quarantine-excludes
export GITHUB_OUTPUT="$fixture_root/output" CALLS="$fixture_root/calls" EXISTING_PATCH="$fixture_root/existing.patch" PROPOSAL
run_decision() { : > "$GITHUB_OUTPUT"; : > "$CALLS"; bash scripts/quarantine-prune-decision.sh; }
assert_output() { grep -Fxq "$1" "$GITHUB_OUTPUT" || { echo "Missing output '$1':" >&2; cat "$GITHUB_OUTPUT" >&2; exit 1; }; }
# First run: no proposal exists, so the action must write one.
PROPOSAL=''; run_decision; assert_output 'outcome=write'; [[ "$(cat "$CALLS")" == list ]]
# Second run: the existing proposal is queued and must not be inspected or written.
PROPOSAL=$'42\t0123456789abcdef0123456789abcdef01234567\ttrue'; run_decision
assert_output 'outcome=queued'; assert_output 'pull-request-number=42'; [[ "$(cat "$CALLS")" == list ]]
# An unqueued proposal with the identical removals is an idempotent no-op.
PROPOSAL=$'42\t0123456789abcdef0123456789abcdef01234567\tfalse'
git diff --no-ext-diff -- bunfig.toml ':(glob)**/bunfig.toml' > "$EXISTING_PATCH"
run_decision; assert_output 'outcome=unchanged'; assert_output 'head=0123456789abcdef0123456789abcdef01234567'
[[ "$(cat "$CALLS")" == $'list\ndiff' ]]
# A stale proposal is refreshed.
printf 'stale patch\n' > "$EXISTING_PATCH"; run_decision; assert_output 'outcome=write'
[[ "$(cat "$CALLS")" == $'list\ndiff' ]]
echo 'quarantine prune decision scenarios passed'
