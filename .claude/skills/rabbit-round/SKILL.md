---
name: rabbit-round
description: "Process one evidence-backed round of automated pull-request review comments from CodeRabbit, Gemini, Copilot, Devin, Greptile, and similar bots."
---

# Rabbit Round

Process one round of automated review feedback. Use `/finish-pr` when the user
wants repeated monitoring until a pull request converges. Never request an
automated review; handle the threads that arrive on their own.

## 1. Capture the Review State

Resolve the repository, PR, current head SHA, requester identity, draft state,
and applicable comment-attribution rules. Fail visibly if the PR cannot be
identified.

Fetch paginated review threads through GitHub GraphQL so unresolved state and
thread replies are preserved. Fetch top-level issue comments separately. Record
every participant and reply author in a thread, which comments apply to the
current head, and which are stale. Treat a thread as bot-authored only when every
participant is a confirmed allowed bot; a mixed or uncertain thread follows the
human-thread rules.

Do not rely only on the REST review-comments list: it does not represent thread
resolution or the complete conversation reliably.

## 2. Triage Every Actionable Bot Finding

Classify each unresolved bot review thread and each actionable top-level bot
comment:

- **Accept**: correct and improves safety, behavior, tests, or maintainability.
- **Accept with adjustment**: the concern is valid but the proposed fix conflicts
  with repository structure or a stronger invariant.
- **Already addressed**: current code or a pushed commit demonstrably resolves it.
- **Push back**: incorrect, stale, speculative, or contrary to documented
  constraints.
- **Defer**: accepted, but landing in a named follow-up PR because the enclosing
  workflow's review budget is spent. Only with the follow-up PR's URL, and every
  defer in one run names the same PR. Never for a verified release-blocking
  defect (security, authorization, data loss, corruption): those are fixed on the
  current head.

Read the cited code and applicable instructions before deciding. Treat security,
authorization, data loss, and compatibility claims as hypotheses to verify, not
as votes to accept automatically. Never modify or resolve human review threads.

## 3. Implement Before Replying

Apply accepted changes, including tests when they cover a real failure mode. Run
focused checks while iterating and the repository's canonical affected-change or
CI-equivalent verification before publication when practical.

Commit and push the implementation before saying it is fixed. Push a new branch
normally; use `--force-with-lease` only after intentionally rebasing a published
branch. Capture the resulting head SHA. If this round pushes a new head, its
final status is `pending_bots` even when GitHub has not registered checks or
reviewers yet; a newly published head cannot be clean in the same pass.

## 4. Reply With Verifiable Evidence

Reply in the review thread or top-level issue conversation for each handled bot
finding. Keep responses short and factual:

- implemented in `<sha>` with the relevant behavior
- implemented with an adjustment and why
- already addressed, with the code or commit that proves it
- not changing, with a concrete repository constraint or technical reason
- deferred to a named follow-up PR, with its URL

Follow repository attribution rules for GitHub comments. Do not claim a check
passed unless it ran successfully on the reported head.

After replying, resolve only review threads whose every participant is a
confirmed allowed bot and that are implemented, already addressed, answered with
a supported pushback, or deferred to a named follow-up PR. Leave human,
mixed-participant, and uncertain threads open. Top-level comments have no
thread-resolution state: a reply naming the follow-up PR is the whole disposition
there. Do not minimize bot summaries by default.

## 5. Recheck the Current Head

Refresh the PR after the push and report one status:

- `clean`: all current-head automated reviewers are terminal, required checks
  are green, and no actionable automated finding remains in a review thread or
  top-level comment. A top-level finding answered with a defer reply carrying the
  follow-up PR's URL is no longer actionable on later rounds, unless it names a
  verified release-blocking defect: no defer makes one of those non-actionable,
  and the status stays `needs_changes` until it is fixed on the current head
- `pending_bots`: this round pushed the current head, or a current-head
  automated review or required check is still running
- `needs_changes`: actionable automated feedback remains
- `failing_ci`: a current-head required check failed

Preserve the PR's explicit draft state. This skill performs one pass; it does not
schedule polling, merge, deploy, or bypass protections.
