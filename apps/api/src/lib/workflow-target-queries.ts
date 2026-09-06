import { panic } from "better-result";
import { and, asc, count, eq, inArray, lte, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createTimestampIdCursorCodec,
  parsePgTimestampCursorValue,
  pgTimestampCursorBoundary,
  pgTimestampCursorValue,
} from "@/api/lib/db-pagination";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";
import { resolveWorkflowTargetEntityIds } from "@/api/lib/workflow-targets";
import type { WorkflowTargetEntityRow } from "@/api/lib/workflow-targets";

type FullWorkflowTargetCursor = {
  createdAt: string;
  id: SafeId<"entity">;
};

const workflowTargetCursorCodec = createTimestampIdCursorCodec({
  column: entities.createdAt,
  brandId: brandPersistedEntityId,
});

const parseTimestamp = (value: string) =>
  parsePgTimestampCursorValue(value) ??
  panic("Stored workflow timestamp cursor is invalid");

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
      sql`SELECT ${pgTimestampCursorValue(sql`now()`)} AS value`,
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
}): Promise<FullWorkflowTargetCursor[]> => {
  const cutoffTimestamp = parseTimestamp(createdAtCutoff);
  const cursorCondition = (() => {
    if (lastCursor === null) {
      return undefined;
    }
    const timestamp = parsePgTimestampCursorValue(lastCursor.createdAt);
    if (timestamp === null) {
      return panic("Workflow target cursor row is invalid");
    }
    return workflowTargetCursorCodec.keysetAfter({
      cursor: { timestamp, id: lastCursor.id },
      direction: "ascending",
      idColumn: entities.id,
    });
  })();
  return await scopedDb((tx) =>
    tx
      .select({
        createdAt:
          workflowTargetCursorCodec.cursorValue.as("created_at_cursor"),
        id: entities.id,
      })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, workspaceId),
          eq(entities.kind, "document"),
          lte(entities.createdAt, pgTimestampCursorBoundary(cutoffTimestamp)),
          cursorCondition,
        ),
      )
      .orderBy(asc(entities.createdAt), asc(entities.id))
      .limit(LIMITS.workflowEntityBatchSize),
  );
};

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
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- keyset page walk: each page's cursor is the previous page's last row
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
  const cutoffTimestamp = parseTimestamp(createdAtCutoff);
  const rows = await scopedDb((tx) =>
    tx
      .select({ value: count() })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, workspaceId),
          eq(entities.kind, "document"),
          lte(entities.createdAt, pgTimestampCursorBoundary(cutoffTimestamp)),
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
