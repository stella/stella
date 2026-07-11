import { Result } from "better-result";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  notInArray,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { t } from "elysia";

import type { ConditionNode } from "@stll/conditions";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { cellMetadata, entities, properties } from "@/api/db/schema";
import type { EntityKind } from "@/api/db/schema-validators";
import {
  buildKanbanGroupCondition,
  tGroupByPropertyId,
} from "@/api/handlers/entities/kanban-group-condition";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { acquireCellLock } from "@/api/lib/cell-lock";
import { tConditionNode } from "@/api/lib/conditions/contract";
import { tSafeId } from "@/api/lib/custom-schema";
import { buildFilterConditions } from "@/api/lib/entity-filters";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import {
  buildColumnFlagMutation,
  sortColumnFlagTargetsForLocking,
} from "./mark-column-flag.logic";

const TABLE_COLUMN_FLAG_EXCLUDED_ENTITY_KINDS = [
  "folder",
  "task",
] satisfies EntityKind[];
const COLUMN_FLAG_TARGET_BATCH_SIZE = 500;
const VERIFIED_COLUMN_FLAG = "verified";

const config = {
  permissions: {
    entity: ["update"],
  },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: t.Object({
    propertyId: tSafeId("property"),
    flag: t.Literal(VERIFIED_COLUMN_FLAG),
    filters: t.Array(tConditionNode),
    set: t.Optional(t.Boolean()),
    // Undo of a prior mark: only remove flags stamped with this operation
    // timestamp (returned as `addedAt` from the original mark).
    onlyAddedAt: t.Optional(t.String()),
    // When set, scopes the batch to a single grouped-view subtable using the
    // same group condition the grouped table renders with, so "mark this group
    // as reviewed" touches exactly the rows that group shows.
    groupByPropertyId: t.Optional(tGroupByPropertyId),
    groupValue: t.Optional(t.Nullable(t.String({ maxLength: 1000 }))),
    // The property's option values, so marking the uncategorized subtable folds
    // in stale-valued cells the same way the grouped table renders them.
    optionValues: t.Optional(t.Array(t.String({ maxLength: 1000 }))),
  }),
} satisfies HandlerConfig;

type MarkColumnFlagBatchResult =
  | {
      status: "ok";
      updatedCount: number;
      hasMore: boolean;
      nextCursor: SafeId<"entity"> | null;
    }
  | {
      status: "property-not-found";
    };

type ProcessColumnFlagBatchArgs = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  propertyId: SafeId<"property">;
  flag: string;
  set: boolean;
  onlyAddedAt: string | undefined;
  filters: ConditionNode[];
  groupCondition: SQL | null;
  userId: SafeId<"user">;
  cursor: SafeId<"entity"> | null;
  addedAt: string;
  recordAuditEvent: AuditRecorder;
};

const processColumnFlagBatch = async ({
  safeDb,
  workspaceId,
  propertyId,
  flag,
  set,
  onlyAddedAt,
  filters,
  groupCondition,
  userId,
  cursor,
  addedAt,
  recordAuditEvent,
}: ProcessColumnFlagBatchArgs): Promise<
  Result<MarkColumnFlagBatchResult, SafeDbError>
> =>
  await safeDb(async (tx): Promise<MarkColumnFlagBatchResult> => {
    const propertyRows = await tx
      .select({ id: properties.id })
      .from(properties)
      .where(
        and(
          eq(properties.id, propertyId),
          eq(properties.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    const property = propertyRows.at(0);

    if (!property) {
      return { status: "property-not-found" };
    }

    const cursorCondition = cursor ? gt(entities.id, cursor) : undefined;
    const entityRows = await tx
      .select({
        entityId: entities.id,
        entityVersionId: entities.currentVersionId,
      })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, workspaceId),
          isNotNull(entities.currentVersionId),
          notInArray(entities.kind, TABLE_COLUMN_FLAG_EXCLUDED_ENTITY_KINDS),
          ...buildFilterConditions(filters),
          ...(groupCondition ? [groupCondition] : []),
          ...(cursorCondition ? [cursorCondition] : []),
        ),
      )
      .orderBy(asc(entities.id))
      .limit(COLUMN_FLAG_TARGET_BATCH_SIZE)
      .for("update");
    const nextCursor = entityRows.at(-1)?.entityId ?? null;
    const hasMore = entityRows.length === COLUMN_FLAG_TARGET_BATCH_SIZE;

    const targets = sortColumnFlagTargetsForLocking(
      entityRows.flatMap((row) =>
        row.entityVersionId
          ? [
              {
                entityId: row.entityId,
                entityVersionId: row.entityVersionId,
              },
            ]
          : [],
      ),
    );

    if (targets.length === 0) {
      return {
        status: "ok",
        updatedCount: 0,
        hasMore,
        nextCursor,
      };
    }

    for (const target of targets) {
      // oxlint-disable-next-line no-await-in-loop -- sequential lock acquisition in a deterministic order avoids deadlocks within the transaction
      await acquireCellLock({
        tx,
        entityVersionId: target.entityVersionId,
        propertyId: property.id,
      });
    }

    const existingRows = await tx
      .select({
        entityVersionId: cellMetadata.entityVersionId,
        metadata: cellMetadata.metadata,
      })
      .from(cellMetadata)
      .where(
        and(
          eq(cellMetadata.workspaceId, workspaceId),
          eq(cellMetadata.propertyId, property.id),
          inArray(
            cellMetadata.entityVersionId,
            targets.map((target) => target.entityVersionId),
          ),
        ),
      )
      .for("update");

    const mutation = buildColumnFlagMutation({
      workspaceId,
      propertyId: property.id,
      flag,
      set,
      ...(onlyAddedAt !== undefined && { onlyAddedAt }),
      targets,
      existingRows,
      userId,
      addedAt,
    });

    if (mutation.insertValues.length > 0) {
      await tx
        .insert(cellMetadata)
        .values(mutation.insertValues)
        .onConflictDoUpdate({
          target: [cellMetadata.entityVersionId, cellMetadata.propertyId],
          set: {
            metadata: sql`excluded.metadata`,
            updatedBy: userId,
            updatedAt: new Date(),
          },
        });
    }

    if (mutation.auditEvents.length > 0) {
      await recordAuditEvent(tx, mutation.auditEvents);
    }

    return {
      status: "ok",
      updatedCount: mutation.updatedCount,
      hasMore,
      nextCursor,
    };
  });

const markColumnFlag = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, user, recordAuditEvent }) {
    let groupCondition: SQL | null = null;
    if (body.groupByPropertyId !== undefined) {
      const conditionResult = buildKanbanGroupCondition({
        groupByPropertyId: body.groupByPropertyId,
        groupValue: body.groupValue ?? null,
        optionValues: body.optionValues,
      });
      if (Result.isError(conditionResult)) {
        return Result.err(conditionResult.error);
      }
      groupCondition = conditionResult.value;
    }

    let updatedCount = 0;
    let cursor: SafeId<"entity"> | null = null;
    const addedAt = new Date().toISOString();

    while (true) {
      const txResult: MarkColumnFlagBatchResult = yield* Result.await<
        MarkColumnFlagBatchResult,
        SafeDbError
      >(
        processColumnFlagBatch({
          safeDb,
          workspaceId,
          propertyId: body.propertyId,
          flag: body.flag,
          set: body.set ?? true,
          onlyAddedAt: body.onlyAddedAt,
          filters: body.filters,
          groupCondition,
          userId: user.id,
          cursor,
          addedAt,
          recordAuditEvent,
        }),
      );

      if (txResult.status === "property-not-found") {
        return Result.err(
          new HandlerError({
            status: 404,
            message: "Property not found in workspace",
          }),
        );
      }

      updatedCount += txResult.updatedCount;

      if (!txResult.hasMore || !txResult.nextCursor) {
        break;
      }

      cursor = txResult.nextCursor;
    }

    // `addedAt` stamps every flag this mark added; the client passes it back as
    // `onlyAddedAt` to undo precisely.
    return Result.ok({ success: true, updatedCount, addedAt });
  },
);

export default markColumnFlag;
