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
import { t } from "elysia";

import type { SafeDb, SafeDbError } from "@/api/db";
import { cellMetadata, entities, properties } from "@/api/db/schema";
import type { EntityKind } from "@/api/db/schema-validators";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { acquireCellLock } from "@/api/lib/cell-lock";
import { tSafeId } from "@/api/lib/custom-schema";
import { buildFilterConditions } from "@/api/lib/entity-filters";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  tViewFilterConditionSchema,
  type ViewFilterCondition,
} from "@/api/lib/views-schema";

import {
  buildColumnFlagMutation,
  sortColumnFlagTargetsForLocking,
} from "./mark-column-flag.logic";

const TABLE_COLUMN_FLAG_EXCLUDED_ENTITY_KINDS = [
  "folder",
  "task",
] satisfies EntityKind[];
const COLUMN_FLAG_TARGET_BATCH_SIZE = 500;

const config = {
  permissions: {
    entity: ["update"],
  },
  body: t.Object({
    propertyId: tSafeId("property"),
    flag: t.String({ minLength: 1, maxLength: 64 }),
    filters: t.Array(tViewFilterConditionSchema),
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
  filters: ViewFilterCondition[];
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
  filters,
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
          filters: body.filters,
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

    return Result.ok({ success: true, updatedCount });
  },
);

export default markColumnFlag;
