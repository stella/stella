---
name: open-pr
description: "Prepare the current change or stack for review: isolate it, rebase, self-review, run proportionate repository checks, push safely, and open or update the pull request."
---

# Open PR

Prepare the current change or stack for review without disturbing unrelated
work.

## 1. Resolve Scope and Isolation

Inspect the branch, worktree, status, remotes, applicable repository
instructions, and existing PR before changing history. Resolve the base
repository first (step 3) and query it explicitly; in a fork checkout, `gh`
defaults to the fork and would miss an upstream PR:

```bash
git branch --show-current
git status --short
gh pr list --repo "$BASE_REPO" --head "$(git branch --show-current)" \
  --state all \
  --json number,state,isDraft,headRefName,headRepositoryOwner,baseRefName,url
```

An empty PR list means no PR exists. `--head` filters by branch name alone, so
in a fork workflow the list can hold another contributor's PR from a branch of
the same name: treat a result as this checkout's PR only when its
`headRepositoryOwner` is the owner your head remote pushes to.

Authentication, network, or repository errors must remain visible and stop the
workflow before history changes or publication.

Never prepare a PR in a dirty shared checkout. If the checkout is on the
default branch, detached, has unrelated changes, or spans repositories or
submodules, move the intended work to a clean worktree with a concise inferred
branch name. Transfer only owned commits or hunks; do not stash, reset, or
silently include unrelated files. Ask only when ownership cannot be determined
safely.

Follow the repository's rerere policy. Review every replayed conflict
resolution before continuing.

## 2. Bootstrap Before Trusting Failures

Confirm the repository toolchain, dependencies, submodules, generated sources,
and expected environment links exist in the isolated worktree. Run the normal
setup flow when they do not, then retry the same check. Missing tools or modules
are not product regressions. Keep setup-only lockfile or generated churn out of
the PR.

## 3. Rebase the Correct Layer

Resolve the actual base branch and repository rather than assuming
`origin/main`. Check `gh extension list` before invoking the optional
`github/gh-stack` extension.
If it is installed and `gh stack view` identifies a stack, use
`gh stack rebase` and review each layer against its parent. If the extension is
absent or the branch is not stacked, use ordinary Git; do not install an
optional extension merely to prepare a normal PR.

For an existing PR, read its `baseRefName` and base repository with `gh pr
view`. Match that repository to a configured Git remote, fetch the PR base from
that remote, and rebase onto the fetched base. If no configured remote matches,
fetch the base repository URL directly and rebase onto `FETCH_HEAD`; do not add
or rewrite remotes silently.

For a branch without a PR, prefer its configured upstream remote and that
remote's default branch. Fall back to `origin` only when no upstream is
configured, then resolve the remote default through its symbolic `HEAD` or
repository metadata. Fetch immediately before rebasing.

Resolve deterministic conflicts directly. Ask when competing resolutions
would change behavior or discard work whose ownership is unclear.

## 4. Review the Actual Change

Read applicable instruction files, then inspect the complete semantic diff and
changed canonical sources. For generated artifacts, review their source in full
and inspect the generated delta for drift; do not reread large mechanical
copies.

Check for accidental files, invalid states, authorization and disclosure
boundaries, missing generated/i18n synchronization, duplicated capabilities (an
existing owner the change bypasses; consult the repository's ownership map, such
as `docs/module-ownership.md`, and its shared packages),
validation of data a boundary already validated, migration compatibility,
performance, replay safety, and tests that cover real failure modes. Fix
confirmed defects before publishing.

## 5. Run Proportionate Checks

Use the repository's canonical verification command for code changes. Start
with focused checks while iterating, then run the CI-equivalent command before
push when the task and machine allow it.

For documentation or skill-only changes, run their owning generators and
validators, formatting verification, and `git diff --check`; do not run
unrelated application suites as ritual. Let pre-push hooks run their affected
gates.

Honor explicit constraints on heavy local checks. Record what was skipped and
rely on CI rather than silently invoking equivalent work another way.

## 6. Apply Security Review by Risk

Always inspect for secrets, private identifiers, unsafe public wording, and
local paths. Run the repository security-audit workflow when the change touches
a security boundary or the user requests it. Fix validated in-scope high-risk
findings before publication and follow the repository's public-disclosure
policy.

## 7. Commit and Push Safely

Use focused commits that follow repository conventions. Push a new branch
normally. Use `--force-with-lease`, never plain force, only after intentionally
rebasing a published branch. For a stack, submit every layer and verify each PR
targets its parent.

## 8. Open or Update Review State

- An explicit draft request creates or preserves a draft.
- An ordinary request to open a complete PR creates it ready for review.
- Keep a PR draft only when requested or when the change is knowingly
  incomplete; state the reason.

Write a concise title and body describing only the visible implementation.
Follow repository rules for attribution and public context. Do not add a test
plan unless requested.

Report the URL, readiness, checks run or skipped, and any blocker. Do not begin
bot monitoring, merge, or deployment unless the user requested that broader
workflow.
