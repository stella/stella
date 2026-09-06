---
name: finish-pr
description: "Drive an existing pull request to a converged review state by addressing feedback and CI repeatedly; merge only when the user explicitly requests it."
---

# Finish PR

Bring an existing pull request to a current-head state that is reviewable or
mergeable. This is a convergence workflow: repeat review and validation until a
terminal condition is reached.

## 1. Establish Authority and Isolation

Resolve the PR, repository, branch, current head SHA, base branch, draft state,
required checks, review state, and applicable repository instructions. Work from
a clean isolated checkout of the PR head. Preserve unrelated changes.

Rebase or restack according to repository policy before trusting results. Review
conflict resolutions and push safely. Preserve an explicit draft state unless the
user asks to mark the PR ready.

Merge, deployment, and protection bypass each require explicit user authority. A
request to finish review does not imply any of them.

## 2. Review Independently

Inspect the complete semantic diff against the correct base and fix confirmed
defects. Run proportionate focused checks, then the repository's canonical
CI-equivalent verification when practical. Treat generated artifacts by their
canonical source and check the generated delta for drift.

## 3. Converge Reviews and CI

Run `/rabbit-round` for the current head. Push accepted fixes before replying to
review threads. Then refresh reviews and required checks for the new head.

When bots or CI are still running, use the environment's monitor or wait mechanism;
do not occupy the shell with sleep polling. Repeat only when new evidence arrives:
a completed check, new review, new commit, or changed thread state.

Investigate failures from their logs and fix causes within scope. Do not rerun a
failed job repeatedly without a reason, weaken checks, reseed baselines, dismiss
valid reviews, or bypass protections merely to make the PR green.

Never request an automated review (`@coderabbitai review`, `@codex review`, or a
timed re-request after a rate limit); reviews arrive on their own. Budget the loop:
at most two review rounds after the first green head. When actionable findings keep
arriving past that, keep the green head and triage the remaining findings yourself
with a concrete accept, push-back, or defer. Open one stacked follow-up PR for the
accepted fixes, then reply to each deferred finding with that PR's URL, and resolve
the thread where the finding has one: the named follow-up is the disposition, not a
promise. A deferred top-level comment stays open; the reply is its terminal state.

The budget never defers a release-blocking defect. A finding that names a
security, authorization, data-loss, or data-corruption defect, and survives
verification, is fixed on this head however late it arrives: shipping a known
defect to keep a round count is the outcome the budget exists to avoid.

## 4. Stop at a Real Terminal State

The latest pushed head has converged only when:

- required CI is green
- automated reviewers are terminal, not pending
- no actionable automated finding remains in a review thread or a top-level
  comment: each is implemented, already addressed, pushed back with evidence,
  or deferred to a named follow-up PR, and no verified release-blocking defect
  was deferred
- no unresolved human request for changes remains
- no blocking review or merge conflict remains

If convergence requires a user decision, new authority, unavailable credentials,
or an external state change, report the exact blocker and the evidence already
collected.

Merge only when explicitly requested. Use the repository's documented merge entry
point (a merge script or queue) when one exists; a raw merge command bypasses its
assertions. Never use admin authority to bypass a correctness failure. After any
authorized merge, verify the PR state and report the resulting commit.

Report the PR URL, latest head, review and CI state, changes made, validation run,
and whether the terminal state is ready, merged, or blocked.
