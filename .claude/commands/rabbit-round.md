# Rabbit Round

Process automated PR review comments systematically. Run this for CodeRabbit, Google
Code Assist (Gemini), GitHub Copilot, Devin, and so on.

## Instructions

1. **Get context** - PR number and current GitHub user:

   ```bash
   # Get PR number for this branch
   gh pr view --json number -q '.number'

   # Get current GitHub username (for CC attribution)
   gh api user --jq '.login'
   ```

2. **Fetch all review comments** from AI bots:

   ```bash
   gh api repos/{owner}/{repo}/pulls/{pr_number}/comments --paginate
   ```

   Filter for comments from `coderabbitai[bot]`, `gemini-code-assist[bot]`,
   `github-copilot[bot]`, `devin-ai-integration[bot]`, and similar bots.

   **Human comments:** Never resolve human review comments. You may reply to push
   back if incorrect, or ask for clarification - but leave the thread open for
   the human to resolve.

3. **For each bot review comment**, analyze the suggestion and decide:
   - **Accept**: If the suggestion improves code quality, correctness, or follows
     our patterns
   - **Push back**: If the suggestion doesn't apply, is incorrect, or conflicts
     with our conventions (documented in CLAUDE.md files)

4. **Reply to each comment** using `in_reply_to` parameter:

   ```bash
   gh api repos/{owner}/{repo}/pulls/{pr_number}/comments \
     -X POST \
     -f body="[response]

   CC on behalf of @{username}" \
     -f commit_id="{commit_sha}" \
     -f path="{file_path}" \
     -F in_reply_to={comment_id}
   ```

   Note: The `in_reply_to` parameter threads the reply correctly under the original
   comment.

5. **Resolve addressed bot conversations** using GraphQL (never resolve human comments):

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

6. **Check nitpick suggestions** (marked with `[nitpick]` or similar) - these
   should also be addressed, not ignored.

7. **Implement accepted suggestions**:
   - Make the code changes for suggestions you agreed with
   - Group related changes logically

8. **Run quality checks**:

   Run the quality checks for the project (using `ruff format`, `ruff check`, `ty`
   for Python, `bun run lint`, `bun run format`, `bun run typecheck` for TypeScript).

9. **Commit and push**:
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
