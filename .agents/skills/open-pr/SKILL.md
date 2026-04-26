---
name: open-pr
description: 'Prepare the current worktree branch for a pull request: rebase, self-review, quality checks, open a draft PR, then run one rabbit round.'
---

# Open PR

Prepare the current worktree branch for a pull request: rebase,
self-review, quality checks, open a draft PR, then run one rabbit
round.

## Instructions

1. **Verify you are on an isolated feature branch**:

   ```bash
   CURRENT=$(git branch --show-current)
   if [ "$CURRENT" = "main" ] || [ "$CURRENT" = "master" ]; then
     echo "Error: /open-pr must not run from the default branch."
     exit 1
   fi
   ```

   If on main, abort and ask the user which feature branch to
   use.

   Check whether the current checkout is safe to use for PR prep:

   ```bash
   git status --short
   ```

   If the checkout is the user's shared root checkout, has
   unrelated local changes, or the work spans multiple repos or
   submodules, stop and move to clean worktree(s) before rebasing
   or committing. Create the worktree from the current feature
   branch and continue the rest of this skill there; do not
   rewrite history in the dirty root checkout.

2. **Bootstrap the worktree before trusting failures**:

   Before running lint, typecheck, tests, or hooks, verify that
   the worktree actually has the repo toolchain available
   (`bun`, workspace dependencies, `turbo`, `oxlint`, project
   bins, and env links if the repo expects them).

   If the worktree is missing the toolchain, run the repo's
   normal install/setup flow first, then rerun the same command.
   Do not treat missing-bin or module-resolution failures as
   product-code regressions. Keep setup-only churn such as
   accidental lockfile changes out of the PR unless the task
   explicitly requires them.

3. **Rebase onto remote main**:

   ```bash
   git fetch origin main
   git rebase origin/main
   ```

   If conflicts arise, resolve them. After resolving, continue
   the rebase. If a conflict is ambiguous, ask the user.

4. **Self-review against CLAUDE.md conventions**:

   Get the full diff against main:

   ```bash
   git diff origin/main --name-only
   ```

   Read every changed file in full. Review against the
   conventions in CLAUDE.md (TypeScript strictness, error
   handling, security, naming, i18n, patterns). Fix any
   violations directly; don't just list them. Commit fixes
   separately with `fix: address self-review findings`.

5. **Run all quality checks**:

   ```bash
   bun run lint \
     && bun run format \
     && bun run typecheck \
     && bun run test
   ```

   If any check fails, fix the issue and re-run. Commit fixes
   with `fix: lint/format/type errors`.

6. **Security audit**:

   Run `/security-audit`. Fix any critical or high findings
   in files changed in this PR before opening it.
   Commit fixes with `fix: address security audit findings`.

7. **Open the PR as draft**:

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

8. **Run one rabbit round**:

   Once the draft PR is open, invoke `/rabbit-round` once.

   Do not assume background scheduling tools exist. Do not create
   cron jobs, loops, or recurring tasks from this skill. If another
   round is needed, the user or caller can invoke `/rabbit-round`
   again later.

   **Pending bots are not clean.** A round where review bot
   checks are still running or queued (e.g., CodeRabbit,
   Copilot, Gemini) does **not** count as a clean check.
   The absence of comments while bots are pending means
   they haven't responded yet, not that they have nothing
   to say. Only count a round as clean when all review bot
   check runs have completed.

   If `/rabbit-round` returns `pending_bots`, `needs_changes`, or
   `failing_ci`, leave the PR as draft and report the status. If it
   returns `clean`, `/rabbit-round` will mark a draft PR as ready for
   review before returning.
