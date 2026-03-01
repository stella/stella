# Deslop

Clean up AI-generated code in the current branch. Remove
over-engineering, unnecessary abstractions, and verbose patterns
that AI tends to produce.

## Instructions

1. **Find what changed** — get the diff against main:

   ```bash
   git diff main --name-only
   ```

2. **Read each changed file** in full and look for these patterns:

   ### Remove
   - **Obvious comments** — `// Get the user` above `getUser()`.
     Only keep comments that explain _why_, not _what_.
   - **Unnecessary type annotations** — TypeScript infers most types.
     Remove annotations on variables/returns where the type is
     obvious from context.
   - **Over-abstraction** — helper functions used exactly once.
     Inline them.
   - **Premature error handling** — try/catch around code that can't
     throw, or error branches for impossible states.
   - **Unnecessary validation** — re-validating data that was already
     validated at the boundary.
   - **Console.log / debug leftovers** — remove unless intentional.
   - **Dead code** — commented-out code, unused imports, unused
     variables.
   - **Verbose boolean logic** — `if (x === true)` → `if (x)`,
     `x ? true : false` → `x`.
   - **Unnecessary async** — `async` on functions that don't await
     anything.
   - **Wrapper functions that just forward** — `const doThing = (x) =>
otherThing(x)` → just use `otherThing` directly.
   - **Excessive destructuring** — `const { foo } = bar; return foo`
     → `return bar.foo`.

   ### Preserve
   - Comments that explain _why_ (business logic, workarounds, gotchas)
   - Error handling at system boundaries (user input, API calls, DB)
   - Type annotations on public API surfaces and exports
   - Abstractions used in multiple places

3. **Make the changes** — edit files directly. Don't ask permission
   for each one, just clean up.

4. **Run checks**:

   ```bash
   bun run lint && bun run format && bun run typecheck && bun run test
   ```

5. **Show a summary** — list what you removed and why, grouped by
   category (comments, abstractions, dead code, etc.).
