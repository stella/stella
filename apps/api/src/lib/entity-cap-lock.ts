import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockWorkspaceCreationStatus,
  withAggregateParentBatch,
} from "@/api/lib/db/aggregate-lock";
import type { RowLockMode } from "@/api/lib/db/aggregate-lock";

/**
 * Canonical lock order for entity creation and hierarchy mutations (issue #1139,
 * follow-up to #1126).
 *
 * All paths that insert rows counted against `LIMITS.entitiesCount`
 * — or that must serialize with such an insert — take locks in this
 * order, inside the same transaction:
 *
 *   1. `lockWorkspacesForEntityCap` (this function): a row-level
 *      `SELECT ... FOR UPDATE` on every `workspaces` row the
 *      operation touches, acquired by the aggregate owner in ascending
 *      workspace-id order.
 *   2. Parent-entity `FOR UPDATE`, only when the insert is scoped to
 *      a folder parent (`checkEntityCreateParentForInsert`).
 *   3. The `document_reference_counters` row for the target
 *      workspace's reference, then the `document_counters` row for the
 *      target workspace, both inside `allocateEntityStamps`.
 *
 * Same-workspace callers lock a single row (step 1 is a list of
 * one). Cross-workspace callers (`copy-to-workspace` with
 * `deleteSource`, moving in either direction between the same two
 * workspaces) pass both workspace ids; sorting them ascending before
 * locking means an A->B move and a concurrent B->A move both lock
 * {A, B} in the SAME order, so neither can hold one row and block on
 * the other (no ABBA).
 *
 * The aggregate owner orders the batch by immutable primary key with
 * COLLATE "C". PostgreSQL sorts rows before LockRows acquires their locks;
 * workspace IDs cannot change while the sorted rows wait for a lock.
 *
 * Participants as of this writing (see #1139 for the full audit):
 *   - `checkEntityCreateCapacityForInsert` (`entity-create.ts`) —
 *     used by `entities/create.ts`, presigned `entity-create.ts`
 *     finalize, `entity-create-tree.ts`, `presign.ts`.
 *   - `moveEntityHandler` (`entities/move.ts`) — locks the workspace
 *     before source/target entity rows and ancestry validation, so two
 *     moves cannot jointly create a cycle from disjoint locked rows.
 *   - `copyEntities` (`copy-utils.ts`) — used by `duplicate.ts`
 *     (same-workspace: locks target only) and `entities/copy.ts`
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
 *   - `workspaces/contacts/create.ts` — takes the parent lock before its
 *     contact count and insert; the contact-capacity trigger uses the same
 *     parent row for direct link writers.
 *
 * Explicitly NOT a participant: `workspaces/duplicate.ts` (whole
 * -workspace clone). It always inserts into a brand-new
 * `targetWorkspaceId` created inside the same transaction, so there
 * is no pre-existing row for a concurrent transaction to contend
 * for — the INSERT itself is the only synchronization the target
 * side needs, and the source side is a read-only snapshot, not an
 * insert counted against the source's cap.
 */
type LockWorkspaceRowsOptions = {
  tx: Transaction;
  workspaceIds: readonly SafeId<"workspace">[];
  mode: RowLockMode;
};

const lockWorkspaceRows = async ({
  tx,
  workspaceIds,
  mode,
}: LockWorkspaceRowsOptions): Promise<void> => {
  // Callers authorize the matter first; a missing row remains an FK failure
  // at insertion rather than a new error from this synchronization helper.
  await withAggregateParentBatch({
    tx,
    organizationIds: [],
    workspaceIds,
    mode,
  });
};

export const lockWorkspacesForEntityCap = async (
  tx: Transaction,
  workspaceIds: readonly SafeId<"workspace">[],
): Promise<void> =>
  await lockWorkspaceRows({ tx, workspaceIds, mode: "update" });

/**
 * The single-workspace `lockWorkspacesForEntityCap`, returning the locked
 * row's status (`undefined` when the row does not exist) so a create can
 * refuse a matter that stopped being active after its access was checked.
 */
export const lockWorkspaceForEntityCreate = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
) => await lockWorkspaceCreationStatus(tx, workspaceId);

/**
 * Transfers wait on source entity/version/field locks. Existing writers may
 * hold those locks while inserting workspace-owned rows, whose FK key-share
 * locks must remain compatible. NO KEY UPDATE still excludes cap-changing
 * inserts and workspace activity updates, without blocking those FK checks.
 */
export const lockWorkspacesForEntityTransfer = async (
  tx: Transaction,
  workspaceIds: readonly SafeId<"workspace">[],
): Promise<void> =>
  await lockWorkspaceRows({ tx, workspaceIds, mode: "no key update" });
