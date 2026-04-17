---
name: dev
description: 'Launch the local dev environment using the project''s dev-runner. The runner handles env symlinks, Docker services, port allocation, health checks, and browser opening automatically.'
---

# Dev Server

Launch the local dev environment using the project's `dev-runner`
(`packages/scripts/src/dev-runner.ts`). The runner handles env
symlinks, Docker services, port allocation, health checks, and
browser opening automatically.

## Instructions

1. **Resolve ports** (dry run):

   Run the dev-runner in dry-run mode to learn which ports it will
   use. The runner hashes the worktree/branch name into a port
   offset so multiple worktrees can run simultaneously.

   ```bash
   bun run dev --dry-run --skip-install --no-browser
   ```

   Parse the `web:` and `api:` lines from the output to get the
   resolved URLs.

2. **Start the dev runner**:

   Launch the full runner in the background. It manages Docker
   services, env symlinks, `db:push`, process lifecycle, and
   readiness polling internally.

   ```bash
   bun run dev --no-browser
   ```

   Run this in the background. The runner exits if any child
   process dies, so a single background command covers everything.

3. **Wait for readiness**:

   Poll the resolved API health endpoint (`{apiUrl}/health`) and
   the web root until both return 200. The dry-run output from
   step 1 gives you the exact URLs. Timeout after ~60 seconds.

4. **Open Chrome** to the running app:

   Use the Claude-in-Chrome MCP tools to navigate to the resolved
   web URL from step 1. If no tab exists, create one.

5. **Verify** the page loads without errors:

   Take a screenshot and check for the "Something went wrong"
   error. If it appears, check console and network errors, and
   debug.

6. **Report** the resolved URLs and status to the user.
