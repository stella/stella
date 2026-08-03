---
name: rabbit-round
description: 'Process one evidence-backed round of unresolved automated PR review comments and current CI without claiming work before it is pushed.'
---

# Rabbit Round

Process one round of CodeRabbit, Gemini Code Assist, Copilot, Devin, and similar
automated review feedback. This skill is intentionally single-pass; use
`/finish-pr` when the user asks to keep watching until convergence.

## 1. Resolve Context

Get the PR, current head, repository, and requester identity:

```bash
gh pr view --json number,headRefOid,headRefName,baseRefName,isDraft,url
gh api user --jq '.login'
```

Every published reply ends with `CC on behalf of {username}` as plain text,
without `@` or a profile link.

## 2. Fetch the Complete Current Review State

Use paginated GraphQL `reviewThreads` and keep unresolved threads. Fetch
top-level issue comments separately because some bots post there. Include
nitpicks and filter by bot authorship; never resolve, minimize, or otherwise
moderate a human-authored thread.

Record thread ID, comment database ID, path, author, body, and whether the
comment targets the current head or stale code. Deduplicate repeated bot
findings before acting.

## 3. Decide From Code, Not Authority

Read the applicable `AGENTS.md`, changed file, surrounding contract, tests, and
current diff. Classify every bot point:

- **accept**: a reachable correctness, security, typing, performance,
  maintainability, or convention defect;
- **accept with modification**: the concern is real but the proposed patch is
  weaker than the repository pattern;
- **push back**: disproven, stale, purely stylistic, or conflicting with an
  established invariant;
- **already addressed**: current remote head demonstrably contains the fix.

Never accept a suggestion merely to make the unresolved count zero.

## 4. Implement Before Replying

Implement all accepted findings, add the strongest proportionate regression
guard, and run focused checks. Use `bun run verify` for the final code pass when
appropriate; honor explicit local-check constraints and report them.

Commit and push the fixes before telling GitHub they are implemented. A new
branch pushes normally; a deliberately rebased published branch uses
`--force-with-lease`.

## 5. Reply, Then Resolve

After the implementation exists on the remote head:

- reply in the review thread using `in_reply_to`;
- state the concrete resolution or concise evidence for pushback;
- append the required attribution;
- resolve the addressed bot thread through GraphQL.

For top-level bot comments, reply only when a response is useful. Do not hide a
bot summary by default; minimize it only when the user explicitly asks and it
has been fully addressed. Never claim “implemented” before the fixing commit is
pushed.

## 6. Check CI and Bot Completion

Inspect current-head checks and failed logs:

```bash
gh pr checks --json name,state,link
gh run list --branch "$(git branch --show-current)" --limit 5 \
  --json status,conclusion,name,databaseId,headSha
```

Ignore failures from an obsolete head. Fix current-head CI root causes in scope;
do not suppress them or widen baselines mechanically. If this round pushed a
new commit, bots and CI must be considered pending even when the previous head
was green.

## 7. Return One Status

- `clean`: current head is green, review bots are complete, and no actionable
  automated thread remains;
- `pending_bots`: checks/review are still running or this round pushed a new
  head;
- `needs_changes`: actionable feedback remains unresolved;
- `failing_ci`: current-head CI still fails after the attempted fixes.

When clean, preserve an explicitly requested draft state unless the user asks
to mark it ready. Stop after reporting the single-round status; do not schedule
another round from inside this skill.

## Reply Shapes

```text
Accepted and fixed in <commit>. <What changed and what guards it>.

CC on behalf of username
```

```text
Pushing back: <specific evidence showing why the finding does not apply>.

CC on behalf of username
```
