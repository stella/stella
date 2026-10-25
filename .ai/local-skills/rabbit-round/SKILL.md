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
and current PR body. Fail visibly if the PR cannot be identified.

Pin every GitHub query and mutation to the resolved full `owner/name` repository
and PR number; never rely on the checkout's implicit repository or branch. Require
each fetched PR's repository identity, number, and `headRefOid` to match the
captured identity. Before editing the PR body or resolving a thread, refetch that
exact PR and stop if its head changed; results from one head never authorize a
mutation on another.

This workflow never posts GitHub comments, review-thread replies, or reviews.
Every handled finding is recorded in the PR body (Section 4); the only thread
mutation it performs is resolving a bot-only thread once its disposition is
recorded.

Fetch paginated review threads through GitHub GraphQL so unresolved state and
every comment in a thread are preserved. Fetch top-level issue comments
separately. Record every participant in a thread, which comments apply to the
current head, and which are stale. Classify participants from a fresh fetch:
every participant must be a confirmed allowed bot, and a human, mixed, or
uncertain thread follows the human-thread rules.

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

## 3. Implement Before Recording

Apply accepted changes, including tests when they cover a real failure mode. Run
focused checks while iterating and the repository's canonical affected-change or
CI-equivalent verification before publication when practical.

Commit and push the implementation before recording it as fixed. Push a new
branch normally; use `--force-with-lease` only after intentionally rebasing a
published branch. Capture the resulting head SHA. A newly published head cannot
be `clean` in the same pass, even when GitHub has not registered checks or
reviewers yet; classify it using the Section 5 precedence.

## 4. Record Dispositions in the PR Body

Record one entry in the PR body for each handled bot finding, whether it came
from a review thread or a top-level comment. Name the finding (reviewer and file
or topic) and keep each entry short and factual:

- implemented in `<sha>`, with the relevant behavior and the evidence that
  shows it (a test, a check, or the changed code)
- implemented with an adjustment in `<sha>`, and why the adjustment holds
- already addressed, with the code or commit that proves it
- not changing, with the evidence for the pushback: a concrete repository
  constraint or technical reason
- deferred to a named follow-up PR, with its URL

Refetch the PR body immediately before editing it and change only the
dispositions section, so concurrent edits to the rest of the body survive. Do not
claim a check passed unless it ran successfully on the reported head.

Resolve a review thread only after its fix is on the current head and its PR
body entry is recorded. Refetch the thread first and triage any new bot finding in it. Resolve it
only when every participant is a confirmed allowed bot and the finding is
implemented, already addressed, answered with supported pushback, or deferred to
a named follow-up PR. Any human, unknown, mixed-participant, or uncertain
participant leaves the thread open. Top-level bot comments have no resolution
state: the PR body entry is the whole disposition there. Do not minimize bot
summaries by default.

## 5. Recheck the Current Head

Refresh the PR after the push and report one status. Apply this precedence:
`failing_ci` > `needs_changes` > `pending_bots` > `clean`.

- `failing_ci`: a current-head required check is known to have failed, regardless
  of pending reviewers, actionable feedback, or a push in this round
- `needs_changes`: no required check is known to have failed, but actionable
  automated feedback remains
- `pending_bots`: no required check is known to have failed and no actionable
  automated feedback remains, but this round pushed the current head or a
  current-head automated review or required check is still running
- `clean`: all current-head automated reviewers are terminal, required checks
  are green, and no actionable automated finding remains in a review thread or
  top-level comment. A top-level finding whose PR body entry defers it to a
  follow-up PR's URL is no longer actionable on later rounds, unless it names a
  verified release-blocking defect: no defer makes one of those non-actionable,
  and the status stays `needs_changes` until it is fixed on the current head

Preserve the PR's explicit draft state. This skill performs one pass; it does not
schedule polling, merge, deploy, or bypass protections.
