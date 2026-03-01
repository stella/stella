# Improve

Fix a code issue and add a CLAUDE.md rule so it doesn't happen again.

## Arguments

$ARGUMENTS — Description of what's wrong with the code (may include
a file reference from the user's selection).

## Instructions

1. **Understand the issue** — read the referenced code and understand
   what the user is pointing out. Don't just fix the symptom; identify
   the root cause in your reasoning. If the issue involves code you
   wrote, check `git diff` to see what changed — verify you didn't
   introduce the problem before blaming external tools or frameworks.

2. **Explain your thinking** — briefly state:
   - What you did wrong
   - Why you did it that way (what mental shortcut or habit led to it)

3. **Fix the code** — make the minimal change to resolve the issue.
   Run typecheck after to confirm the fix compiles.

4. **Add a CLAUDE.md rule** — write a concise, actionable guideline
   in the appropriate section of `CLAUDE.md` that would have prevented
   this mistake. Rules should be:
   - Imperative ("Do X", "Don't Y"), not descriptive
   - Specific enough to act on, not vague platitudes
   - Placed in the relevant section (TypeScript, Backend, Error
     Handling, etc.)
   - Short: one to three lines max

5. **Verify** — run `bun run lint && bun run typecheck` to confirm
   nothing is broken.
