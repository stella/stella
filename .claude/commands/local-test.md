# Local Test

Prepare and launch the local dev environment for the current worktree
(or main worktree). Handles the common pain points: stale processes
blocking ports, missing `.env` files, and opening the browser.

## Instructions

1. **Symlink `.env` files** (worktrees only):

   Detect whether we are in a git worktree (`.git` is a file, not a
   directory). If so, resolve the main worktree root and symlink any
   missing `.env` files:
   - `.env`
   - `apps/web/.env`
   - `apps/api/.env`

   Skip files that already exist in the worktree.

2. **Kill stale processes on ports 3000 and 3001**:

   Other worktrees may leave orphaned processes bound to the
   default ports. Kill all processes on both ports; they will
   be (re)started in the next steps.

   ```bash
   lsof -t -i :3000 -i :3001 | xargs kill -9 2>/dev/null || true
   ```

3. **Start the API on port 3001**:

   Start the API from the **current worktree** (feature branch).

   First ensure Docker Compose services are up:

   ```bash
   cd apps/api && bun run docker:dev
   ```

   Then start the API:

   ```bash
   cd apps/api && bun --port 3001 --watch src/index.ts
   ```

   Run this in the background. Wait a few seconds and verify it
   started.

4. **Start the web dev server on port 3000**:

   Always use the default port 3000:

   ```bash
   cd apps/web && bun run dev -- --port 3000
   ```

   Run this in the background. Wait for the "ready" message.

5. **Open Chrome** to the running app:

   Use the Claude-in-Chrome MCP tools to navigate to
   `http://localhost:3000`. If no tab group exists, create one.

6. **Verify** the page loads without errors:

   Take a screenshot and check for the "Something went wrong" error.
   If it appears, check console and network errors, and debug.

7. **Report** the URL and status to the user.
