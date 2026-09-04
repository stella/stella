---
name: plan
description: "Create a concise, evidence-backed implementation plan in the repository planning area when the user explicitly asks for a plan."
---

# Plan

Create an implementation plan only when the user explicitly requests one. A
plan records decisions and executable slices; it is not a substitute for
inspecting the repository.

## 1. Establish the Planning Context

Read applicable repository instructions and the existing planning system.
Prefer the repository's established location and format. When present, inspect:

- `.agents/ARCHITECTURE.md`
- `.agents/GOALS.md`
- `.agents/STATUS.md`
- recent related plans
- the code, tests, schemas, and configuration the task would change

Use `$ARGUMENTS` as a short slug when provided; otherwise derive one from the
task.

Do not create a second planning system. Use `.agents/plans/` only when it is
already established or the repository clearly adopts the shared convention.
If no planning area exists and the repository does not adopt this convention,
ask the user where to save the plan before creating a new directory.

## 2. Resolve Decisions With Evidence

Trace the current behavior through real entry points and boundaries. Record
facts separately from proposals. Ask about a materially different product,
security, migration, or compatibility choice only when repository evidence
cannot resolve it. Do not pause for discoverable implementation details.

Prefer vertical slices that leave the repository working after each slice when
the implementation shape is sufficiently settled. Otherwise plan outcomes and
contracts without inventing files or symbols. Identify ownership boundaries,
data contracts, invalid states, rollout risks, and generated artifacts
explicitly.

Before proposing a new helper, module, or schema, check
`docs/module-ownership.md` and the existing packages for the capability. Name
the owner the slice extends, or state why a second implementation is correct.

## 3. Create a Collision-Safe File

Follow the repository's existing naming scheme when one exists and is safe for
concurrent worktrees. Otherwise use:

```text
YYYYMMDD-HHMMSS-<slug>-<short-unique-suffix>.md
```

Use UTC for the timestamp. Create the file exclusively and retry with a new
suffix on collision. Never overwrite an existing plan. Do not derive a global
sequential number from a directory listing: concurrent worktrees can choose the
same number.

## 4. Write the Plan

Use only sections that carry information:

```markdown
# Plan: [Feature]

## Goal

What outcome changes, for whom, and why.

## Current State

Relevant behavior, entry points, constraints, and evidence.

## Decisions

- **Decision**: choice, alternatives considered, and why they were rejected.

## Scope

In scope and intentionally out of scope.

## Vertical Slices

1. End-to-end slice with real files, boundaries, and a verifiable outcome.

## Contracts and Invariants

Types, schemas, authorization, compatibility, idempotency, and failure behavior.

## Verification

Focused checks, integration coverage, and observable acceptance criteria.

## Rollout and Recovery

Migration, sequencing, monitoring, rollback, or "Not applicable".

## Open Questions

Only unresolved decisions that can change the plan.
```

Name concrete files and symbols only where repository evidence and settled
implementation decisions support them. Avoid pseudocode unless a contract would
otherwise remain ambiguous. Keep the plan concise enough to stay useful during
implementation.

Report the created path and any decision that still needs the user.
