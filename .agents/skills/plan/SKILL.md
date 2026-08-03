---
name: plan
description: 'Create a concise, evidence-backed implementation plan in `.agents/plans/` when the user explicitly asks for a plan artifact.'
---

# Create Plan

Create an implementation plan only when the user explicitly asks for one. A
plan is a durable handoff artifact, not a substitute for resolving the product
shape first.

## Arguments

`$ARGUMENTS` describes the feature, task, or plan slug. Infer a short
kebab-case slug from the conversation when none is supplied.

## Workflow

1. **Check decision readiness.** Separate settled decisions from genuine open
   questions. If a missing answer would materially change the product or
   architecture, resolve it with the user before writing. Do not pause for
   choices that can be discovered from the repository or decided safely from
   existing conventions.
2. **Read current evidence.** Read the applicable `AGENTS.md`,
   `.agents/GOALS.md` when present, relevant code and tests, and nearby plans.
   Treat code and current repository instructions as authoritative; do not
   require optional context files that are absent.
3. **Create a collision-resistant filename.** Use UTC timestamp, slug, and a
   short unique suffix:

   ```bash
   date -u +%Y%m%d-%H%M%S
   ```

   Write `.agents/plans/{timestamp}-{slug}-{unique}.md` using exclusive file
   creation. If the candidate exists, generate a new suffix and retry; never
   overwrite an existing plan. Do not allocate a global sequential number,
   which is race-prone across worktrees.
4. **Write the plan once the shape is coherent.** The user's request to plan
   authorizes creating the file. Do not ask for confirmation after writing or
   add a second save step.

## Plan Shape

```markdown
# Plan: [Feature Name]

Date: YYYY-MM-DD

## Goal

The user-visible or operational outcome, in 1–3 sentences.

## Current State

What exists now, with the relevant files, contracts, and constraints.

## Decisions

- **Decision:** choice and why it wins over the material alternatives.

## Scope

**In:** ...

**Out:** ...

## Vertical Slices

1. Small independently verifiable end-to-end slice.
2. Next slice and its dependency on the first.

## Contracts and Invariants

Types, API/data boundaries, tenant/security rules, failure semantics,
pagination, performance budgets, i18n, and compatibility requirements that
must survive implementation.

## Verification

Tests and checks that can catch real failures the type system or lint cannot.

## Rollout and Recovery

Additive migration order, compatibility window, observability, and rollback or
forward-fix path when relevant.

## Open Questions

Only unresolved decisions that still need a named answer. Omit when empty.
```

## Quality Bar

- Keep the plan concise and specific enough for another agent to implement.
- Prefer vertical slices over horizontal layer checklists.
- Name real files and existing primitives; do not invent paths without
  checking them.
- State what is deliberately deferred so follow-up ideas do not expand the
  first slice.
- Do not write implementation pseudocode unless a contract is otherwise
  ambiguous.
- Report the created plan path and the few decisions that matter most.
