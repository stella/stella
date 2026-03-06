# Rabbit Round

Process automated PR review comments systematically. Run this for CodeRabbit, Google
Code Assist (Gemini), GitHub Copilot, Devin, Greptile, and so on.

## Instructions

1. **Get context** - PR number and current GitHub user:

   ```bash
   # Get PR number for this branch
   gh pr view --json number -q '.number'

   # Get current GitHub username (for CC attribution)
   gh api user --jq '.login'
   ```

2. **Fetch all bot comments** - both review comments and issue comments:

   ```bash
   # Review comments (inline on code)
   gh api repos/{owner}/{repo}/pulls/{pr_number}/comments --paginate

   # Issue comments (top-level PR comments, used by Greptile and others)
   gh api repos/{owner}/{repo}/issues/{pr_number}/comments --paginate
   ```

   Filter for comments from `coderabbitai[bot]`, `gemini-code-assist[bot]`,
   `github-copilot[bot]`, `devin-ai-integration[bot]`, `greptile-apps[bot]`,
   and similar bots.

   **Human comments:** Never resolve or minimize human comments. You may reply
   to push back if incorrect, or ask for clarification - but leave the thread
   open for the human to resolve.

3. **For each bot comment** (review or issue), analyze the suggestion and decide:
   - **Accept**: If the suggestion improves code quality, correctness, or follows
     our patterns
   - **Push back**: If the suggestion doesn't apply, is incorrect, or conflicts
     with our conventions (documented in CLAUDE.md files)

4. **Reply to each comment**:

   For **review comments**, use `in_reply_to` to thread the reply:

   ```bash
   gh api repos/{owner}/{repo}/pulls/{pr_number}/comments \
     -X POST \
     -f body="[response]

   CC on behalf of @{username}" \
     -f commit_id="{commit_sha}" \
     -f path="{file_path}" \
     -F in_reply_to={comment_id}
   ```

   For **issue comments** (top-level PR comments), reply on the issue thread:

   ```bash
   gh api repos/{owner}/{repo}/issues/{pr_number}/comments \
     -X POST \
     -f body="[response]

   CC on behalf of @{username}"
   ```

5. **Resolve addressed bot review threads** using GraphQL (never resolve human
   comments):

   ```bash
   # First, get thread IDs for the PR
   gh api graphql -f query='
   query {
     repository(owner: "{owner}", name: "{repo}") {
       pullRequest(number: {pr_number}) {
         reviewThreads(first: 50) {
           nodes {
             id
             isResolved
             comments(first: 1) {
               nodes { databaseId }
             }
           }
         }
       }
     }
   }'

   # Then resolve each thread by its GraphQL ID
   gh api graphql -f query='
   mutation {
     resolveReviewThread(input: {threadId: "{thread_id}"}) {
       thread { isResolved }
     }
   }'
   ```

6. **Minimize (hide) addressed bot issue comments** using GraphQL. Some bots
   (e.g. Greptile) post as issue comments instead of review comments. These
   cannot be "resolved" like review threads; instead, minimize them so they
   collapse under a "hidden" fold:

   ```bash
   # Use the node_id from the issue comment JSON response
   gh api graphql -f query='
   mutation {
     minimizeComment(input: {
       subjectId: "{comment_node_id}",
       classifier: RESOLVED
     }) {
       minimizedComment { isMinimized }
     }
   }'
   ```

   Only minimize bot comments you have already addressed (accepted or pushed
   back on). Never minimize human comments.

7. **Check nitpick suggestions** (marked with `[nitpick]` or similar) - these
   should also be addressed, not ignored.

8. **Implement accepted suggestions**:
   - Make the code changes for suggestions you agreed with
   - Group related changes logically

9. **Check and fix failing CI**:

   ```bash
   # Find the latest CI run for this PR's branch
   gh run list --branch $(git branch --show-current) --limit 5 \
     --json status,conclusion,name,databaseId

   # View failed run logs
   gh run view {run_id} --log-failed
   ```

   - If CI is failing, read the logs and fix the root cause
   - Common failures: formatting (run `bun run format` with `--write`),
     lint errors, type errors, test failures
   - Fix the issues in code, don't just suppress them

10. **Check React Doctor diagnostics**:

    The React Doctor CI workflow posts a score comment on the PR. Check it
    and fix real issues.

    ```bash
    # Find the React Doctor CI run
    gh run list --branch $(git branch --show-current) \
      --json conclusion,name,databaseId \
      | jq '.[] | select(.name == "React Doctor")'

    # Read the output
    gh run view {run_id} --log | grep -E "(✗|⚠|score|Score)"
    ```

    - Run React Doctor locally for full diagnostics:
      ```bash
      cd apps/web && npx -y react-doctor@latest .
      ```
    - Fix errors (✗) first, then impactful warnings (⚠)
    - **Skip false positives** — common ones in this codebase:
      - `useMemo` wrapping `Math.random()` (keeps value stable)
      - `passive: false` on wheel listeners that call `preventDefault()`
      - Zustand store syncs in useEffect (legitimate side effects)
    - Note which issues are false positives and which are real in
      your commit message

11. **Run quality checks**:

    Run the quality checks for the project (using `ruff format`,
    `ruff check`, `ty` for Python, `bun run lint`, `bun run format`,
    `bun run typecheck` for TypeScript).

12. **Commit and push**:
    - Create a commit with a message like `fix: address review comments`
    - Push to the current branch

## Decision Guidelines

**Accept suggestions when they:**

- Fix actual bugs or potential issues
- Improve type safety
- Follow established patterns in CLAUDE.md
- Enhance readability without over-engineering
- Address security concerns

**Push back when suggestions:**

- Conflict with documented conventions
- Would over-engineer a simple solution
- Are based on incorrect assumptions about the codebase
- Would break existing patterns for marginal benefit
- Are purely stylistic and conflict with our style

## Response Templates

Reply format: Put the response first, then sign with `CC on behalf of @{username}`.

**Accepting:**

```text
Accepted and implemented. [Brief description of change].

CC on behalf of @username
```

**Accepting with modification:**

```text
Agreed with the principle. Implementing with a slight modification: [explain].

CC on behalf of @username
```

**Pushing back:**

```text
Pushing back on this. [Reason]. Our convention is [explain pattern/reference
CLAUDE.md].

CC on behalf of @username
```

**Already addressed:**

```text
Already addressed in commit [hash]. [Brief description].

CC on behalf of @username
```
