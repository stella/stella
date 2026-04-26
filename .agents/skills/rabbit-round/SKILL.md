---
name: rabbit-round
description: 'Process automated PR review comments systematically in one pass for CodeRabbit, Google Code Assist (Gemini), GitHub Copilot, Devin, and similar review bots.'
---

# Rabbit Round

Process automated PR review comments systematically. Run this for CodeRabbit, Google
Code Assist (Gemini), GitHub Copilot, Devin, and similar review bots.

This skill is single-pass. It does one round, reports the current
state, and stops. Do not schedule future runs from inside this skill.

## Instructions

1. **Get context** - PR number and current GitHub user:

   ```bash
   # Get PR number for this branch
   gh pr view --json number -q '.number'

   # Get current GitHub username (for CC attribution)
   gh api user --jq '.login'
   ```

2. **Fetch all bot comments** - Prefer GraphQL for review threads to only process unresolved ones:

   ```bash
   # Fetch all review threads and filter for unresolved ones only
   gh api graphql --paginate -f query='
   query($endCursor: String) {
     repository(owner: "{owner}", name: "{repo}") {
       pullRequest(number: {pr_number}) {
         reviewThreads(first: 50, after: $endCursor) {
           nodes {
             id
             isResolved
             path
             comments(first: 10) {
               nodes {
                 databaseId
                 body
                 author { login }
               }
             }
           }
           pageInfo {
             hasNextPage
             endCursor
           }
         }
       }
     }
   }' | jq '.data.repository.pullRequest.reviewThreads.nodes | map(select(.isResolved == false))'

   # Issue comments (top-level PR comments, used by some bots)
   gh api repos/{owner}/{repo}/issues/{pr_number}/comments --paginate
   ```

   Filter for comments from `coderabbitai[bot]`, `gemini-code-assist[bot]`,
   `github-copilot[bot]`, `devin-ai-integration[bot]`,
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

6. **Minimize (hide) other addressed bot issue comments** using GraphQL.
   Some bots post as issue comments instead of review comments. These
   cannot be "resolved" like review threads; instead, minimize them:

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

   Only minimize bot comments you have already addressed (accepted or
   pushed back on). Never minimize human comments.

7. **Check nitpick suggestions** (marked with `[nitpick]` or similar) -
   these should also be addressed, not ignored.

8. **Implement accepted suggestions**:
   - Make the code changes for suggestions you agreed with
   - Group related changes logically

9. **Check review bot status**:

    Before considering this round clean, verify that all review
    bot checks have completed:

    ```bash
    gh pr checks $(gh pr view --json number -q '.number') \
      --json name,state \
      | jq '[.[] | select(
          (.name | test("coderabbit|copilot|gemini|devin"; "i"))
          and (.state | IN("PENDING","QUEUED","REQUESTED",
                           "WAITING","IN_PROGRESS"))
        )]'
    ```

    If any review bot checks are still in a non-terminal state,
    this round is **not clean** even if there are zero unresolved
    comments. Report `pending_bots` and stop.

10. **Check and fix failing CI**:

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

11. **Check React Doctor diagnostics**:

    The React Doctor CI workflow posts a score comment on the PR.
    Check it and fix real issues.

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
      - `passive: false` on wheel listeners that call
        `preventDefault()`
      - Zustand store syncs in useEffect (legitimate side effects)
    - Note which issues are false positives and which are real in
      your commit message

12. **Run quality checks**:

    Run the quality checks for the project (using `ruff format`,
    `ruff check`, `ty` for Python, `bun run lint`, `bun run format`,
    `bun run typecheck` for TypeScript).

13. **Commit and push**:
    - Create a commit with a message like
      `fix: address review comments`
    - Push to the current branch
    - If you pushed new commits in this step, return `pending_bots`
      in the final status because CI and review bots need to run on
      the new commit

14. **Report one round status and stop**:

    Return exactly one of:
    - `clean`: no actionable bot comments remain, review bot checks are
      complete, and CI is green
    - `pending_bots`: review bots have not finished yet, or new
      commits were just pushed and checks are re-running
    - `needs_changes`: actionable bot comments remain
    - `failing_ci`: CI is failing and still needs fixes

    If the round is `clean` and the PR is currently a draft, mark it as
    ready for review:

    ```bash
    gh pr ready
    ```

    If the round is not `clean`, summarize what remains and stop. A
    caller may invoke `/rabbit-round` again later.

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
