import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * Canonical lock order for every entity-creating path (issue #1139,
 * follow-up to #1126).
 *
 * All paths that insert rows counted against `LIMITS.entitiesCount`
 * — or that must serialize with such an insert — take locks in this
 * order, inside the same transaction:
 *
 *   1. `lockWorkspacesForEntityCap` (this function): a row-level
 *      `SELECT ... FOR UPDATE` on every `workspaces` row the
 *      operation touches, acquired ONE AT A TIME in ascending
 *      workspace-id order (never via a single multi-row query — see
 *      below).
 *   2. Parent-entity `FOR UPDATE`, only when the insert is scoped to
 *      a folder parent (`checkEntityCreateParentForInsert`).
 *   3. The `document_counters` row for the target workspace, via
 *      `allocateEntityStamp`'s `INSERT ... ON CONFLICT DO UPDATE`.
 *
 * Same-workspace callers lock a single row (step 1 is a list of
 * one). Cross-workspace callers (`copy-to-workspace` with
 * `deleteSource`, moving in either direction between the same two
 * workspaces) pass both workspace ids; sorting them ascending before
 * locking means an A->B move and a concurrent B->A move both lock
 * {A, B} in the SAME order, so neither can hold one row and block on
 * the other (no ABBA).
 *
 * Locks are taken with sequential single-row queries, not one
 * `WHERE id IN (...) ORDER BY id FOR UPDATE`: Postgres places the
 * row-locking step (`LockRows`) below `ORDER BY` in the plan, so an
 * `ORDER BY` does NOT guarantee lock-acquisition order for `FOR
 * UPDATE` — only issuing the queries in order does.
 *
 * Participants as of this writing (see #1139 for the full audit):
 *   - `checkEntityCreateCapacityForInsert` (`entity-create.ts`) —
 *     used by `entities/create.ts`, presigned `entity-create.ts`
 *     finalize, `entity-create-tree.ts`, `presign.ts`.
 *   - `copyEntities` (`copy-utils.ts`) — used by `duplicate.ts`
 *     (same-workspace: locks target only) and `copy-to-workspace.ts`
 *     (cross-workspace: locks {source, target} ascending whenever
 *     `deleteSource` also needs the source row).
 *   - `entities/clip.ts`, `entities/create-from-buffer.ts`,
 *     `entities/upload.ts`, `tasks/create.ts` — single-workspace
 *     inserts, previously unlocked (or advisory-locked under a
 *     separate `entity-cap:` domain in #1126) count-then-insert
 *     sequences.
 *   - `infosoud/agenda-import.ts` — moved here from its own bare
 *     `pg_advisory_xact_lock(hashtext(workspaceId))` domain (shared,
 *     confusingly, with unrelated property-write and time-entry
 *     locks); see that file's comment for why the move is safe.
 *
 * Explicitly NOT a participant: `workspaces/duplicate.ts` (whole
 * -workspace clone). It always inserts into a brand-new
 * `targetWorkspaceId` created inside the same transaction, so there
 * is no pre-existing row for a concurrent transaction to contend
 * for — the INSERT itself is the only synchronization the target
 * side needs, and the source side is a read-only snapshot, not an
 * insert counted against the source's cap.
 */
export const lockWorkspacesForEntityCap = async (
  tx: Transaction,
  workspaceIds: readonly SafeId<"workspace">[],
): Promise<void> => {
  const orderedIds = [...new Set(workspaceIds)].sort();

  for (const id of orderedIds) {
    // Raw `FOR UPDATE`, not the query-builder form: it locks the
    // exact same `workspaces` row either way (Postgres doesn't care
    // how the SQL was generated), but matches the `tx.execute(sql...)`
    // shape every other advisory/row lock in this codebase already
    // uses. A missing row is not distinguished here — access control
    // upstream already guarantees `workspaceId` exists for every
    // caller, and the insert that follows has an FK to `workspaces`
    // that would fail regardless.
    //
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop -- sequential, ascending-id acquisition is the invariant this function exists to provide; see the module doc comment
    await tx.execute(
      sql`SELECT id FROM ${workspaces} WHERE id = ${id} FOR UPDATE`,
    );
  }
};
