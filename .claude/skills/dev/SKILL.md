---
name: dev
description: 'Launch the local dev environment using the project''s dev-runner. The runner handles env symlinks, migrations, port allocation, and readiness checks; worktree infrastructure needs an independently owned offset.'
---

# Dev Server

Launch the local dev environment using the project's `dev-runner`
(`packages/scripts/src/dev-runner.ts`). The runner handles env
symlinks, Docker services, migrations, port allocation, and health
checks.

## Instructions

1. **Resolve application ports** (dry run):

   Run the dev-runner in dry-run mode to learn which ports it will
   use. The runner hashes the worktree/branch name into a port
   offset so multiple worktrees can run simultaneously.

   ```bash
   bun run dev --dry-run --skip-install --no-browser
   ```

   If this exits before the runner starts with a missing-package or
   module-resolution error, run `bun ci` once and retry the exact same
   dry-run command. Do not treat other failures as bootstrap errors or retry
   them this way.

   Parse the numeric `offset:` and the `web:` and `api:` URLs. This
   offset covers application ports only; do not copy it into
   `--infra-offset` without the independent ownership check below.

2. **Resolve infrastructure ownership**:

   Offset `0` belongs to the root checkout and its shared Docker
   project. A non-root worktree needs a stable non-zero offset whose
   Compose project and volumes belong to that worktree.

   Reuse a previously recorded assignment for the same canonical
   worktree path. For a new assignment, select from the full valid
   infrastructure range, reserve the candidate with a race-safe
   lock, and validate all five shifted ports (Postgres, Valkey,
   RustFS API, RustFS console, and Gotenberg). Reject the candidate if
   any of those ports intersects the dry-run web or API ports, or if
   any container or Docker volume already uses the corresponding
   `stella-dev-<offset>` project unless its Compose working-directory
   label matches this worktree. Probe another candidate on any
   ownership or port collision.

   The runner hashes application offsets into only 400 buckets and
   checks application ports separately. That hash is not an
   infrastructure ownership mechanism, and adjacent infrastructure
   offsets can overlap because RustFS uses consecutive ports.

3. **Start the dev runner**:

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

4. **Handle cold-start setup safely**:

   The first isolated run creates Docker volumes and applies every
   migration, so it can take longer. Never reset or repair the
   shared database to resolve migration drift. In a non-root
   worktree, confirm the command uses its owned non-zero
   `--infra-offset`; in the root checkout, keep offset `0`.

   If the runner completes infrastructure and migrations but exits
   only because its application-readiness deadline elapsed, rerun
   the same command once. The expensive setup is cached. If the
   second run fails, inspect its logs and report the blocker.

5. **Use the runner's readiness result**:

   Capture the live runner output and read the final summary for the
   exact web and API URLs. Infrastructure startup or another process
   can make the runner move away from the dry-run application offset,
   so never poll or report the preliminary URLs from step 1. The
   runner prints its final summary only after its bounded internal
   readiness checks pass; do not duplicate those checks or open a
   browser to verify them again.

6. **Report** the resolved URLs and status to the user. Leave the
   runner active until the user asks to stop it.
