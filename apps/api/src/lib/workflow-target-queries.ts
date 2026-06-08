import { panic } from "better-result";
import { and, asc, count, eq, gt, inArray, or, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { entities } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { resolveWorkflowTargetEntityIds } from "@/api/lib/workflow-targets";
import type { WorkflowTargetEntityRow } from "@/api/lib/workflow-targets";

type FullWorkflowTargetCursor = {
  createdAt: string;
  id: SafeId<"entity">;
};

const WORKFLOW_TIMESTAMP_CURSOR_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US';

const chunkEntityIds = (
  entityIds: readonly SafeId<"entity">[],
): SafeId<"entity">[][] => {
  const chunks: SafeId<"entity">[][] = [];
  for (
    let index = 0;
    index < entityIds.length;
    index += LIMITS.workflowEntityBatchSize
  ) {
    chunks.push(entityIds.slice(index, index + LIMITS.workflowEntityBatchSize));
  }
  return chunks;
};

export const fetchExplicitWorkflowTargetRows = async ({
  inputEntityIds,
  scopedDb,
  workspaceId,
}: {
  inputEntityIds: readonly SafeId<"entity">[];
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
}): Promise<WorkflowTargetEntityRow[]> => {
  const entityRows: WorkflowTargetEntityRow[] = [];
  for (const chunk of chunkEntityIds(inputEntityIds)) {
    const rows = await scopedDb((tx) =>
      tx
        .select({ id: entities.id, kind: entities.kind })
        .from(entities)
        .where(
          and(
            eq(entities.workspaceId, workspaceId),
            inArray(entities.id, chunk),
          ),
        ),
    );
    for (const row of rows) {
      entityRows.push(row);
    }
  }

  return entityRows;
};

export const readFullWorkflowSnapshotCursor = async ({
  scopedDb,
}: {
  scopedDb: ScopedDb;
}): Promise<string> => {
  const rows = await scopedDb((tx) =>
    tx.execute<{ value: string }>(
      sql`SELECT to_char(now(), ${WORKFLOW_TIMESTAMP_CURSOR_FORMAT}) AS value`,
    ),
  );
  const row = rows.at(0);
  if (!row) {
    return panic("Workflow snapshot cursor query returned no rows");
  }

  return row.value;
};

const fetchFullWorkflowTargetBatch = async ({
  createdAtCutoff,
  lastCursor,
  scopedDb,
  workspaceId,
}: {
  createdAtCutoff: string;
  lastCursor: FullWorkflowTargetCursor | null;
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
}): Promise<FullWorkflowTargetCursor[]> =>
  await scopedDb((tx) =>
    tx
      .select({
        createdAt: sql<string>`to_char(${entities.createdAt}, ${WORKFLOW_TIMESTAMP_CURSOR_FORMAT})`,
        id: entities.id,
      })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, workspaceId),
          eq(entities.kind, "document"),
          sql`${entities.createdAt} <= ${createdAtCutoff}::timestamp`,
          ...(lastCursor === null
            ? []
            : [
                or(
                  sql`${entities.createdAt} > ${lastCursor.createdAt}::timestamp`,
                  and(
                    sql`${entities.createdAt} = ${lastCursor.createdAt}::timestamp`,
                    gt(entities.id, lastCursor.id),
                  ),
                ),
              ]),
        ),
      )
      .orderBy(asc(entities.createdAt), asc(entities.id))
      .limit(LIMITS.workflowEntityBatchSize),
  );

export const collectFullWorkflowTargetIds = async ({
  createdAtCutoff,
  scopedDb,
  workspaceId,
}: {
  createdAtCutoff: string;
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
}): Promise<SafeId<"entity">[]> => {
  const entityIds: SafeId<"entity">[] = [];
  let lastCursor: FullWorkflowTargetCursor | null = null;

  while (true) {
    const rows = await fetchFullWorkflowTargetBatch({
      createdAtCutoff,
      lastCursor,
      scopedDb,
      workspaceId,
    });

    if (rows.length === 0) {
      return entityIds;
    }

    for (const row of rows) {
      entityIds.push(row.id);
    }

    const lastRow = rows.at(-1);
    if (!lastRow) {
      return entityIds;
    }
    lastCursor = lastRow;
  }
};

const countFullWorkflowTargets = async ({
  createdAtCutoff,
  scopedDb,
  workspaceId,
}: {
  createdAtCutoff: string;
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
}): Promise<number> => {
  const rows = await scopedDb((tx) =>
    tx
      .select({ value: count() })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, workspaceId),
          eq(entities.kind, "document"),
          sql`${entities.createdAt} <= ${createdAtCutoff}::timestamp`,
        ),
      ),
  );
  const row = rows.at(0);
  if (!row) {
    return panic("Full workflow target count query returned no rows");
  }

  return row.value;
};

export const countWorkflowTargetEntities = async ({
  inputEntityIds,
  scopedDb,
  workspaceId,
}: {
  inputEntityIds?: readonly SafeId<"entity">[] | undefined;
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
}): Promise<number> => {
  if (inputEntityIds !== undefined && inputEntityIds.length > 0) {
    const targetEntityIds = resolveWorkflowTargetEntityIds({
      entityRows: await fetchExplicitWorkflowTargetRows({
        inputEntityIds,
        scopedDb,
        workspaceId,
      }),
      inputEntityIds,
    });
    return targetEntityIds.length;
  }

  return await countFullWorkflowTargets({
    createdAtCutoff: await readFullWorkflowSnapshotCursor({ scopedDb }),
    scopedDb,
    workspaceId,
  });
};
