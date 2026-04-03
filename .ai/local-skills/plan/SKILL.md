---
name: plan
description: 'Create a new plan file in `.agents/plans/` for a feature or task.'
---

# Create Plan

Create a new plan file in `.agents/plans/` for a feature or task.

## Arguments

$ARGUMENTS — A short slug for the plan (kebab-case), e.g. "full-text-search"
or "matter-lifecycle". If empty, determine an appropriate slug from
the conversation context.

## Instructions

1. **Read context** — read `.agents/ARCHITECTURE.md` and `.agents/GOALS.md`
   to understand the current system and priorities.

2. **Determine the next plan number** — list existing plans and increment:

   ```bash
   ls .agents/plans/
   ```

   Use the next sequential number (e.g., if `001-matters.md` exists,
   use `002`).

3. **Research the feature** — before writing the plan, explore the
   codebase to understand what exists, what needs to change, and what
   the implications are. Read relevant handler files, schema, routes,
   and components.

4. **Write the plan** to `.agents/plans/{number}-{slug}.md` with this
   structure:

   ```markdown
   # Plan: [Feature Name]

   Date: YYYY-MM-DD

   ## Goal

   What are we building and why? 1-3 sentences.

   ## Design Decisions

   Key choices and why we made them. Focus on _what_ and _why_,
   not prescriptive implementation details.

   - **Decision 1**: Why this approach over alternatives.
   - **Decision 2**: Why this approach over alternatives.

   ## Scope

   **In scope:**

   - ...

   **Out of scope:**

   - ...

   ## Implementation

   Where the code lives and what changes. Be specific about files.

   - `apps/api/src/...` — what changes here
   - `apps/web/src/...` — what changes here
   - DB schema changes (if any)

   ## Test Cases

   What needs to be tested.

   ## Open Questions

   Unresolved decisions (remove section when all resolved).
   ```

5. **Plan guidelines**:
   - Focus on _what_ and _why_, avoid prescriptive _how_
   - Consider both API layers: backend handlers and frontend routes
   - Note DB schema changes explicitly — they affect migrations
   - Flag security implications (ethical walls, workspace isolation,
     auth) per the security audit checklist
   - Keep it concise — a plan is a thinking tool, not documentation

6. **Confirm with the user** — show the plan and ask if they want to
   adjust anything before saving.
