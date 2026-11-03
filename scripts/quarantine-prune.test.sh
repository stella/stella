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
if [[ "$1 $2" == "pr diff" ]]; then echo diff >> "$CALLS"; cat "$PATCH_RESPONSE"; exit 0; fi
if [[ "$1" == "api" && "$*" == *"/pulls/42/files"* ]]; then echo files >> "$CALLS"; cat "$PR_FILES"; exit 0; fi
if [[ "$1" == "api" && "$*" == *"/contents/"* ]]; then
  for argument in "$@"; do
    [[ "$argument" == *"/contents/"* ]] && path="${argument#*/contents/}"
  done
  echo "content:$path" >> "$CALLS"
  printf '{"content":"%s","encoding":"base64"}\n' "$(base64 < "$PROPOSAL_ROOT/$path" | tr -d '\n')"
  exit 0
fi
exit 99
STUB
chmod +x "$fixture_root/gh"
export PATH="$fixture_root:$PATH" GITHUB_REPOSITORY=stella/stella PRUNE_BRANCH=chore/prune-quarantine-excludes
export GH_RETRY_SCRIPT="$fixture_root/gh"
export GITHUB_OUTPUT="$fixture_root/output" CALLS="$fixture_root/calls" PR_FILES="$fixture_root/files.json" PROPOSAL_ROOT="$fixture_root/proposal" PATCH_RESPONSE="$fixture_root/patch" PROPOSAL
mkdir -p "$fixture_root/repo/apps/web" "$PROPOSAL_ROOT/apps/web"
cp scripts/quarantine-prune-decision.sh "$fixture_root/repo/decision.sh"
printf 'minimumReleaseAge = 3\n' > "$fixture_root/repo/bunfig.toml"
printf 'minimumReleaseAge = 3\n' > "$fixture_root/repo/apps/web/bunfig.toml"
git -C "$fixture_root/repo" init -q
git -C "$fixture_root/repo" add bunfig.toml apps/web/bunfig.toml
git -C "$fixture_root/repo" -c user.name=test -c user.email=test@example.com commit -qm fixture
printf 'minimumReleaseAge = 4\n' > "$fixture_root/repo/bunfig.toml"
printf 'minimumReleaseAge = 4\n' > "$fixture_root/repo/apps/web/bunfig.toml"
{
  printf 'From 0123456789abcdef0123456789abcdef01234567 Mon Sep 17 00:00:00 2001\n'
  printf 'From: automation <automation@example.com>\nSubject: [PATCH] prune excludes\n---\n'
  git -C "$fixture_root/repo" diff -- bunfig.toml apps/web/bunfig.toml
} > "$PATCH_RESPONSE"
cp "$fixture_root/repo/bunfig.toml" "$PROPOSAL_ROOT/bunfig.toml"
cp "$fixture_root/repo/apps/web/bunfig.toml" "$PROPOSAL_ROOT/apps/web/bunfig.toml"
printf '[[{"filename":"bunfig.toml"},{"filename":"apps/web/bunfig.toml"}]]\n' > "$PR_FILES"
run_decision() { : > "$GITHUB_OUTPUT"; : > "$CALLS"; (cd "$fixture_root/repo" && bash decision.sh); }
assert_output() { grep -Fxq "$1" "$GITHUB_OUTPUT" || { echo "Missing output '$1':" >&2; cat "$GITHUB_OUTPUT" >&2; exit 1; }; }
# First run: no proposal exists, so the action must write one.
PROPOSAL=''; run_decision; assert_output 'outcome=write'; [[ "$(cat "$CALLS")" == list ]]
# Second run: the existing proposal is queued and must not be inspected or written.
PROPOSAL=$'42\t0123456789abcdef0123456789abcdef01234567\ttrue'; run_decision
assert_output 'outcome=queued'; assert_output 'pull-request-number=42'; [[ "$(cat "$CALLS")" == list ]]
# An unqueued proposal with identical file contents is an idempotent no-op. The
# equivalent `gh pr diff --patch` includes commit metadata, so patch comparison
# would incorrectly classify this proposal as stale.
PROPOSAL=$'42\t0123456789abcdef0123456789abcdef01234567\tfalse'
run_decision; assert_output 'outcome=current'; assert_output 'head=0123456789abcdef0123456789abcdef01234567'
[[ "$(cat "$CALLS")" == $'list\nfiles\ncontent:apps/web/bunfig.toml\ncontent:bunfig.toml' ]]
# A stale proposal is refreshed.
printf 'minimumReleaseAge = 5\n' > "$PROPOSAL_ROOT/bunfig.toml"
run_decision; assert_output 'outcome=write'
[[ "$(cat "$CALLS")" == $'list\nfiles\ncontent:apps/web/bunfig.toml\ncontent:bunfig.toml' ]]
# A proposal that changes an extra bunfig.toml is also stale.
printf '[[{"filename":"bunfig.toml"},{"filename":"apps/web/bunfig.toml"},{"filename":"packages/extra/bunfig.toml"}]]\n' > "$PR_FILES"
run_decision; assert_output 'outcome=write'
[[ "$(cat "$CALLS")" == $'list\nfiles' ]]
echo 'quarantine prune decision scenarios passed'
