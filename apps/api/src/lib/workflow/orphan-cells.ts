import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { AiCellSettlement } from "@stll/api-contract";
import { chunk as chunkItems } from "@stll/concurrency/chunk";
import { Temporal } from "@stll/time";

import type { rootDb } from "@/api/db/root";
import {
  entityVersions,
  extractionRuns,
  fields,
  workspaces,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

/**
 * The cell reads and writes of orphan reconciliation, on the connection the
 * workflow workers were started with. Reconciliation runs outside any request,
 * so the workers' host hands it the one handle all of its reads and writes use.
 */
export type OrphanCellsDatabase = Pick<
  typeof rootDb,
  "select" | "selectDistinct" | "update"
>;

export type PendingCellRow = {
  id: string;
  workspaceId: string;
  entityId: string;
  propertyId: string;
  ownerRunId: string | null;
  ownerBatchId: string | null;
  deadlineAt: Date | null;
  attempt: 0 | 1 | null;
  organizationId: string | null;
  requestedBy: string | null;
};

/** Bounded keyset page used on every scheduled reconciliation tick. */
export const selectPendingCellPage = async (
  database: OrphanCellsDatabase,
  cursor: string | null,
  limit: number,
): Promise<PendingCellRow[]> =>
  await database
    .select({
      id: fields.id,
      workspaceId: fields.workspaceId,
      entityId: entityVersions.entityId,
      propertyId: fields.propertyId,
      ownerRunId: fields.ownerRunId,
      ownerBatchId: fields.ownerBatchId,
      deadlineAt: fields.deadlineAt,
      attempt: sql<0 | 1 | null>`${fields.attempt}`,
      organizationId: workspaces.organizationId,
      requestedBy: extractionRuns.requestedBy,
    })
    .from(fields)
    .innerJoin(entityVersions, eq(entityVersions.id, fields.entityVersionId))
    .innerJoin(workspaces, eq(workspaces.id, fields.workspaceId))
    .leftJoin(
      extractionRuns,
      sql`${extractionRuns.id}::text = ${fields.ownerRunId}`,
    )
    .where(
      and(
        sql`${fields.content}->>'type' = 'pending'`,
        cursor === null ? undefined : sql`${fields.id} > ${cursor}`,
      ),
    )
    .orderBy(asc(fields.id))
    .limit(limit);

/** Settle exactly the pending ownership snapshot selected by the scheduler. */
export const errorPendingCell = async (
  database: OrphanCellsDatabase,
  cell: Pick<PendingCellRow, "id" | "ownerRunId" | "attempt">,
): Promise<boolean> => {
  const rows = await database
    .update(fields)
    .set({
      content: { type: "error", version: 1 },
      aiSettlement: {
        type: "failed",
        runId: cell.ownerRunId,
        settledAt: Temporal.Now.instant().toString(),
      } satisfies AiCellSettlement,
      ownerRunId: null,
      ownerBatchId: null,
      deadlineAt: null,
      attempt: null,
    })
    .where(
      and(
        sql`${fields.id} = ${cell.id}`,
        sql`${fields.content}->>'type' = 'pending'`,
        sql`${fields.ownerRunId} IS NOT DISTINCT FROM ${cell.ownerRunId}`,
        sql`${fields.attempt} IS NOT DISTINCT FROM ${cell.attempt}`,
      ),
    )
    .returning({ id: fields.id });
  return rows.length === 1;
};

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
      : chunkItems(workspaceIds, LIMITS.workflowEntityBatchSize);

  for (const workspaceIdBatch of workspaceIdBatches) {
    const workspaceFilter =
      workspaceIdBatch === null
        ? undefined
        : inArray(
            fields.workspaceId,
            workspaceIdBatch.map((id) => brandPersistedWorkspaceId(id)),
          );
    // db-await-in-loop: one set-based distinct scan per chunk; chunking caps the IN list at workflowEntityBatchSize bound parameters
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
  const settledAt = Temporal.Now.instant().toString();
  const erroredFields = await database
    .update(fields)
    .set({
      content: { type: "error", version: 1 },
      aiSettlement: sql<AiCellSettlement>`jsonb_build_object(
        'type', 'failed',
        'runId', ${fields.ownerRunId},
        'settledAt', ${settledAt}::text
      )`,
    })
    .where(
      and(
        eq(fields.workspaceId, workspaceId),
        sql`${fields.content}->>'type' = 'pending'`,
      ),
    )
    .returning({ id: fields.id });
  return erroredFields.length;
};
