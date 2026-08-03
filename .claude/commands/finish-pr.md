# Finish PR

Use when the user asks to keep addressing CI and review bots until a PR is
ready, or explicitly asks to merge after convergence. This workflow composes
the repository review rules with repeated `/rabbit-round` passes.

## Arguments

`$ARGUMENTS` may include a PR number/URL and an explicit `merge` or
`admin merge` instruction. Without explicit merge authority, stop at clean and
ready for review.

## Workflow

1. Resolve the PR, base/head SHAs, readiness, merge policy, current checks,
   human reviews, and unresolved threads. Never infer merge authority from a
   request to “check,” “review,” or “finish.”
2. Work in a clean isolated checkout of the PR head. Fetch and rebase onto the
   current base (or restack with `gh stack rebase`), then push safely with
   `--force-with-lease` only if the published history changed.
3. Independently review the complete semantic diff against applicable
   `AGENTS.md` and surrounding contracts. Fix confirmed defects and run
   proportionate checks before relying on bots.
4. Run one `/rabbit-round`. If it returns `needs_changes` or `failing_ci`, fix
   the root cause and repeat after the new head is published.
5. If it returns `pending_bots`, use the harness's recurring monitor/wait
   mechanism rather than blocking sleeps or busy polling. Re-run only after
   checks, head SHA, or review state changes. Keep the user informed during
   long waits.
6. Convergence requires the latest head to be stable: CI green, review bots
   terminal, no actionable unresolved automated threads, no unresolved
   requested human changes, and an independent review with no blocking
   finding. A clean old head does not count after a push or rebase.
7. Mark the PR ready when clean. Merge only when the user explicitly requested
   it and repository policy permits it; use the requested normal/admin method
   without bypassing an unresolved correctness concern.

Stop and report a genuine blocker when it requires user authority, unavailable
external state, or a product decision. Do not call an unchanged pending check a
blocker.

## Report

Return the PR URL and head SHA, rebase/review result, checks run, bot and human
thread state, readiness, merge result when authorized, and any residual risk.
