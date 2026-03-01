# Implement Plan

Take a plan from `.agents/plans/` and implement it.

## Arguments

$ARGUMENTS — Plan filename or number, e.g. "003-full-text-search" or
just "3". If empty, list available plans and ask which one.

## Instructions

1. **Find the plan**:

   ```bash
   ls .agents/plans/
   ```

   Match the argument to a plan file. If ambiguous, ask.

2. **Read the plan** in full. Understand the goal, design decisions,
   scope, and implementation notes.

3. **Read referenced files** — before writing any code, read every
   file mentioned in the plan's implementation section. Understand
   existing patterns, imports, and conventions.

4. **Read CLAUDE.md** — refresh on project conventions, coding
   patterns, and error handling approach.

5. **Implement in order**:
   - DB schema changes first (if any)
   - Backend handlers / logic
   - Frontend routes / components
   - Tests

   Commit logical chunks as you go, not one giant commit at the end.

6. **Follow existing patterns** — match the style of surrounding
   code. Don't introduce new patterns unless the plan explicitly
   calls for it.

7. **Skip what's out of scope** — the plan's "Out of scope" section
   exists for a reason. Don't add extras.

8. **Run checks after implementation**:

   ```bash
   bun run lint && bun run format && bun run typecheck && bun run test
   ```

9. **Update the plan** — if you made decisions not covered in the
   plan, or deviated from it, add a "## Implementation Notes" section
   at the bottom of the plan file explaining what changed and why.

10. **Update status** — add a note to `.agents/STATUS.md` if the
    feature is significant.

## If something is unclear

Don't guess. Check the plan's "Open Questions" section — if the
question is listed there, ask the user. If it's not listed but the
plan is ambiguous, ask before proceeding.
