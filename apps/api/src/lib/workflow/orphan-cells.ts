import { and, eq, inArray, sql } from "drizzle-orm";

import type { rootDb } from "@/api/db/root";
import { fields } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { chunked } from "@/api/lib/chunked";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

/**
 * The cell reads and writes of orphan reconciliation, on the connection the
 * workflow workers were started with. Reconciliation runs outside any request,
 * so the workers' host hands it the one handle all of its reads and writes use.
 */
export type OrphanCellsDatabase = Pick<
  typeof rootDb,
  "selectDistinct" | "update"
>;

/**
 * Workspaces that still hold `pending` cells: all of them, or those among
 * `workspaceIds`.
 */
export const selectWorkspacesWithPendingCells = async (
  database: OrphanCellsDatabase,
  workspaceIds?: readonly string[],
): Promise<string[]> => {
  if (workspaceIds?.length === 0) {
    return [];
  }

  const pendingWorkspaceIds: string[] = [];
  const workspaceIdBatches =
    workspaceIds === undefined
      ? [null]
      : chunked(workspaceIds, LIMITS.workflowEntityBatchSize);

  for (const workspaceIdBatch of workspaceIdBatches) {
    const workspaceFilter =
      workspaceIdBatch === null
        ? undefined
        : inArray(
            fields.workspaceId,
            workspaceIdBatch.map((id) => brandPersistedWorkspaceId(id)),
          );
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- one set-based distinct scan per chunk; chunking caps the IN list at workflowEntityBatchSize bound parameters
    const rows = await database
      .selectDistinct({ workspaceId: fields.workspaceId })
      .from(fields)
      .where(and(workspaceFilter, sql`${fields.content}->>'type' = 'pending'`));
    for (const row of rows) {
      pendingWorkspaceIds.push(row.workspaceId);
    }
  }

  return pendingWorkspaceIds;
};

/**
 * Turn an orphaned workspace's `pending` cells into `error` cells. `error`
 * cells stay eligible for re-extraction, so a retry or the next full run
 * picks them back up. Returns how many cells changed.
 */
export const errorPendingCells = async (
  database: OrphanCellsDatabase,
  workspaceId: SafeId<"workspace">,
): Promise<number> => {
  const erroredFields = await database
    .update(fields)
    .set({ content: { type: "error", version: 1 } })
    .where(
      and(
        eq(fields.workspaceId, workspaceId),
        sql`${fields.content}->>'type' = 'pending'`,
      ),
    )
    .returning({ id: fields.id });
  return erroredFields.length;
};
