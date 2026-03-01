# Review PR

Perform a thorough code review of a pull request.

## Arguments

$ARGUMENTS — PR number or branch name. If empty, review the current
branch's PR.

## Instructions

1. **Get PR context**:

   ```bash
   # If no PR number given, get it from current branch
   gh pr view --json number,title,body,baseRefName,headRefName

   # Get the diff
   gh pr diff
   ```

2. **Get all changed files**:

   ```bash
   gh pr view --json files -q '.files[].path'
   ```

3. **Read each changed file in full** (not just the diff) to understand
   context. Read surrounding code, imports, and related files.

4. **Review against these criteria**:

   **Correctness**
   - Does the logic do what it claims?

- Edge cases handled?
  - Are there off-by-one errors, null checks missing, race conditions?
  - Are comments explaining edge cases/reasoning detailed enough and up
    to date?

    **Security** (critical for legal DMS)

  - Auth checks on new endpoints?
  - Input validation present?
  - No SQL injection, XSS, or path traversal?
  - Secrets not hardcoded?
  - External calls have timeouts?

  **Patterns & conventions** (per CLAUDE.md)
  - TypeScript strict (no `any`, no `!` assertions)?
  - Unsafe code has a "SAFETY: ..." comment (e.g. for type assertions with
    `as`)?
  - Drizzle ORM for DB access (no raw SQL)?
  - Zustand with `useShallow()` for multi-selectors?
  - Error handling follows project patterns?

  **Performance**
  - N+1 queries?
  - Unnecessary re-renders?
  - Missing indexes for new DB queries?
  - Large payloads that should be paginated?

  **Testing**
  - Are new features tested?
  - Are edge cases covered?
  - Do existing tests still pass?

5. **Provide feedback** as a structured review:

   For each finding, state:
   - **File:line** — exact location
   - **Severity** — blocker / suggestion / nitpick
   - **Issue** — what's wrong
   - **Suggestion** — how to fix

6. **Post the review as a PR comment** if the user confirms:

   ```bash
   gh pr review {number} --comment --body "review content"
   ```

   Include "CC on behalf of @{username}" at the end.

## Decision Guidelines

**Blockers** — must fix before merge:

- Security vulnerabilities
- Data loss risks
- Breaking changes without migration
- Missing auth checks

**Suggestions** — should fix:

- Pattern violations
- Missing error handling
- Performance issues

**Nitpicks** — nice to fix:

- Naming improvements
- Minor readability tweaks
