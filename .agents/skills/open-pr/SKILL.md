---
name: open-pr
description: 'Prepare the current worktree branch for a pull request: rebase, self-review, quality checks, open the PR, then monitor review comments.'
---

# Open PR

Prepare the current worktree branch for a pull request: rebase,
self-review, quality checks, open the PR, then monitor review
comments.

## Instructions

1. **Verify not on the default branch**:

   ```bash
   CURRENT=$(git branch --show-current)
   if [ "$CURRENT" = "main" ] || [ "$CURRENT" = "master" ]; then
     echo "Error: /open-pr must not run from the default branch."
     exit 1
   fi
   ```

   If on main, abort and ask the user which feature branch to
   use.

2. **Rebase onto remote main**:

   ```bash
   git fetch origin main
   git rebase origin/main
   ```

   If conflicts arise, resolve them. After resolving, continue
   the rebase. If a conflict is ambiguous, ask the user.

3. **Self-review against CLAUDE.md conventions**:

   Get the full diff against main:

   ```bash
   git diff origin/main --name-only
   ```

   Read every changed file in full. Review against the
   conventions in CLAUDE.md (TypeScript strictness, error
   handling, security, naming, i18n, patterns). Fix any
   violations directly; don't just list them. Commit fixes
   separately with `fix: address self-review findings`.

4. **Run all quality checks**:

   ```bash
   bun run lint \
     && bun run format --write \
     && bun run typecheck \
     && bun run test
   ```

   If any check fails, fix the issue and re-run. Commit fixes
   with `fix: lint/format/type errors`.

5. **Security audit**:

   Run `/security-audit`. Fix any critical or high findings
   in files changed in this PR before opening it.
   Commit fixes with `fix: address security audit findings`.

6. **Open the PR as draft**:

   Push the branch and create the PR as a **draft**:

   ```bash
   git push --force-with-lease -u origin HEAD
   gh pr create --fill --draft
   ```

   If `--fill` produces a poor title/body, write a proper one
   following Conventional Commits (`feat:`, `fix:`, etc.) with
   a concise summary and test plan.

   This repository is public. Never include marketing language,
   internal business context, pricing, competitive analysis,
   user identities, conversation specifics, or security
   architecture beyond what the diff shows. Write for the
   reviewing engineer.

7. **Start rabbit round monitoring**:

   Once the draft PR is open, schedule rabbit round monitoring
   using `CronCreate` directly (do **not** use `/loop`, which
   runs immediately — review bots need time to post):

   ```
   CronCreate(cron: "*/7 * * * *", prompt: "/rabbit-round", recurring: true)
   ```

   **When to stop:** cancel the cron job (via `CronDelete`)
   after two consecutive checks find nothing to act on (no
   unresolved bot comments, no new review threads, CI green).
   Do not let it run indefinitely.

   **Pending bots are not clean.** A round where review bot
   checks are still running or queued (e.g., CodeRabbit,
   Copilot, Gemini) does **not** count as a clean check.
   The absence of comments while bots are pending means
   they haven't responded yet, not that they have nothing
   to say. Only count a round as clean when all review bot
   check runs have completed.

8. **Mark PR as ready**:

   After the rabbit round monitoring stops (two consecutive
   clean checks), mark the PR as ready for review:

   ```bash
   gh pr ready
   ```
