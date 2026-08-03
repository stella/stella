# Dev Server

Launch the local dev environment using the project's `dev-runner`
(`packages/scripts/src/dev-runner.ts`). The runner handles env
symlinks, Docker services, migrations, port allocation, and health
checks.

## Instructions

1. **Resolve ports** (dry run):

   Run the dev-runner in dry-run mode to learn which ports it will
   use. The runner hashes the worktree/branch name into a port
   offset so multiple worktrees can run simultaneously.

   ```bash
   bun run dev --dry-run --skip-install --no-browser
   ```

   Parse the numeric `offset:` and the `web:` and `api:` URLs. Use
   that resolved offset as the infrastructure offset so each
   worktree gets its own Postgres, Valkey, MinIO, and Gotenberg
   state. Offset `0` is the shared root-checkout infrastructure.

2. **Start the dev runner**:

   Launch the full runner in the background. It manages Docker
   services, env symlinks, `db:push`, process lifecycle, and
   readiness polling internally.

   ```bash
   bun run dev --no-browser --infra-offset <resolved-offset>
   ```

   Run this in the background. The runner exits if any child
   process dies, so a single background command covers everything.
   Keep dependency installation enabled on the first run. Add
   `--skip-install` only when this worktree is already bootstrapped
   and its dependencies have not changed.

3. **Handle cold-start setup safely**:

   The first isolated run creates Docker volumes and applies every
   migration, so it can take longer. Never reset or repair the
   shared database to resolve migration drift; confirm the command
   uses the resolved non-zero `--infra-offset` instead.

   If the runner completes infrastructure and migrations but exits
   only because its application-readiness deadline elapsed, rerun
   the same command once. The expensive setup is cached. If the
   second run fails, inspect its logs and report the blocker.

4. **Wait for readiness**:

   Poll the resolved API health endpoint (`{apiUrl}/health`) and
   the web root with bounded per-request timeouts until both return
   200. The dry-run output from step 1 gives the exact URLs. Allow
   up to 120 seconds for a cold start.

5. **Report** the resolved URLs and status to the user. Leave the
   runner active until the user asks to stop it.
