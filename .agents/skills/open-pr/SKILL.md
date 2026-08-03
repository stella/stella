---
name: open-pr
description: 'Prepare the current change or stack for review: isolate it, rebase, self-review, run proportionate repository checks, push safely, and open or update the PR.'
---

# Open PR

Prepare the current change or stack for review and publish it without
disturbing unrelated work.

## 1. Resolve Scope and Isolation

Inspect the branch, worktree, status, remotes, and existing PR before changing
history:

```bash
git branch --show-current
git status --short
gh pr view --json number,state,isDraft,headRefName,baseRefName,url 2>/dev/null || true
```

Never prepare a PR in the user's dirty shared checkout. If the checkout is on
the default branch, has unrelated changes, or spans multiple repositories or
submodules, create a clean worktree and a concise inferred branch name. Do not
ask the user to name an ordinary branch; ask only when the intended change
cannot be isolated safely.

When the intended work is uncommitted in the shared checkout, identify and
transfer only its owned hunks into the clean worktree. Do not stash, reset, or
silently carry unrelated files along with it.

Enable rerere before rebasing:

```bash
git config --global rerere.enabled true
git config --global rerere.autoupdate true
```

## 2. Bootstrap Before Trusting Failures

Confirm Bun, workspace dependencies, project binaries, submodules, and expected
env links exist in the isolated worktree. Run the repository's normal setup
when they do not. Retry the same check after setup; missing modules or tools are
not product regressions. Keep setup-only lockfile or generated churn out of the
PR.

## 3. Rebase the Correct Layer

Fetch the base immediately before review. If `gh stack view` shows a stack, use
`gh stack rebase` and review each layer against its immediate parent. Otherwise:

```bash
git fetch origin main
git rebase origin/main
```

Resolve deterministic conflicts directly. Ask only when competing resolutions
would change product behavior or discard work whose ownership is unclear.

## 4. Review the Actual Change

Read applicable `AGENTS.md` files, then inspect the complete semantic diff and
all changed source files. For generated artifacts, review their canonical
source in full and inspect the generated delta for scope/drift; do not spend
context rereading thousands of mechanical lines.

Check for:

- accidental or unrelated files;
- invalid states that types could prevent;
- authorization, tenant, file, external-input, and disclosure boundaries;
- missing i18n/generated synchronization;
- migration compatibility, pagination, performance, and replay safety;
- tests that exercise real failure modes rather than implementation trivia.

Fix confirmed defects before publishing and keep unrelated cleanup separate.

## 5. Run Proportionate Repository Checks

For code changes, `bun run verify` is the canonical local CI-equivalent check.
Start with focused tests/checks while iterating, then run `bun run verify` before
push when the machine and task allow it.

For documentation or skill-only changes, run the generators/validators that own
the files, `bun run sync-ai:check` when applicable, formatting, and
`git diff --check`; do not run unrelated application suites merely to satisfy a
ritual. Let the pre-push hook run its affected gates.

Honor an explicit instruction to skip heavy local checks. Record exactly what
was skipped and rely on CI rather than quietly rerunning it through a different
command.

## 6. Apply Security Review by Risk

Always inspect the diff for secrets, private identifiers, unsafe public
wording, and accidental local paths. Run `/security-audit` when the change
touches authentication, authorization, tenant data, files, AI/tool execution,
external APIs, dependencies, workflows, or another security boundary, or when
the user requests it. A docs-only change still needs a disclosure review, not a
full application threat-model exercise.

Fix validated critical/high findings in scope before publication. Keep public
commit and PR text limited to the implementation visible in the diff.

## 7. Commit and Push Safely

Use focused Conventional Commits. Push a new branch normally:

```bash
git push -u origin HEAD
```

Use `--force-with-lease`, never plain force, only when updating a previously
pushed branch after an intentional rebase. Submit stacks with `gh stack submit
--auto` and verify every PR targets its parent layer.

## 8. Open or Update Review State

- An explicit “draft PR” request creates or keeps a draft.
- An ordinary “open PR” request creates a ready-for-review PR so review bots and
  required review workflows can run.
- Keep a PR draft only when the user requested it or the change is knowingly
  incomplete/broken; state that reason.

Write a concise Conventional Commit-style title and a short body describing
only the visible implementation. Do not add a test-plan section unless the
user asks. Avoid private motivation, identities, deployment details, security
architecture, or wording that advertises a previously exploitable condition.

Report the URL, readiness state, checks run/skipped, and any real blocker. Do
not start bot monitoring, merge, or perform deployment unless the user also
requested that broader workflow.
