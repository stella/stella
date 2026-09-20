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
HEAD_BRANCH="$(git symbolic-ref --quiet --short HEAD)" || {
  echo "detached HEAD; cannot identify a pull request branch" >&2
  exit 1
}
HEAD_SHA="$(git rev-parse --verify HEAD)"
git status --short
: "${BASE_REPO:?set BASE_REPO to the resolved owner/name base repository}"
: "${HEAD_REPO:?set HEAD_REPO to the resolved owner/name head repository}"
PR_CANDIDATES="$(gh pr list --repo "$BASE_REPO" --head "$HEAD_BRANCH" \
  --state open \
  --json number,state,isDraft,headRefName,headRefOid,headRepository,baseRefName,url)"
```

Resolve `BASE_REPO` before the query and resolve `HEAD_REPO` from the branch's
configured push remote. Do not guess either identity from an account name. Filter
`PR_CANDIDATES` to entries whose `headRepository.nameWithOwner` equals `HEAD_REPO`
and whose `headRefOid` equals `HEAD_SHA`, then accept exactly one match and assign
its `number` to `PR_NUMBER`. An empty candidate list means no open PR exists. A
missing repository identity or head SHA, more than one exact match, or a detached
or otherwise ambiguous local branch must stop the workflow before any candidate's
base is used. A non-empty list with no exact match belongs to another head and is
not this checkout's PR. `--head` filters by branch name alone, so matching only the
owner is insufficient: an organization can own multiple repositories in one fork
network.

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

For an existing PR, read its metadata from the exact match rather than the
checkout's implicit repository context:

```bash
PR_METADATA="$(gh pr view "$PR_NUMBER" --repo "$BASE_REPO" --json number,baseRefName,headRefOid,headRepository,url)"
```

Treat the explicit `BASE_REPO` as the base repository and reject a response whose
PR number, head repository, or head SHA no longer matches the identity established
in step 1. Match `BASE_REPO` to a configured Git remote, fetch the PR base from that
remote, and rebase onto the fetched base. If no configured remote matches, fetch
the base repository URL directly and rebase onto `FETCH_HEAD`; do not add or
rewrite remotes silently.

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

Refresh `HEAD_SHA` from the final local commit immediately before pushing. Push
the explicit local branch to its resolved `HEAD_REPO` destination, then verify the
remote branch resolves to that SHA; do not let an implicit push target select the
repository or branch.

## 8. Open or Update Review State

- An explicit draft request creates or preserves a draft.
- An ordinary request to open a complete PR creates it ready for review.
- Keep a PR draft only when requested or when the change is knowingly
  incomplete; state the reason.

Write a concise title and body describing only the visible implementation.
Follow repository rules for attribution and public context. Do not add a test
plan unless requested.

For an existing PR, update only `PR_NUMBER` in `BASE_REPO`; never rely on the
checkout's implicit repository or branch selection. For a new PR, pass the resolved
base repository, base branch, and head repository and branch explicitly. After any
create or update, refetch that exact PR and require its repository identity and
`headRefOid` to equal `BASE_REPO` and the pushed `HEAD_SHA` before reporting it.

Report the URL, readiness, checks run or skipped, and any blocker. Do not begin
bot monitoring, merge, or deployment unless the user requested that broader
workflow.
