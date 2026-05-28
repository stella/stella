import { Result } from "better-result";
import { and, asc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { t } from "elysia";

import { cellMetadata, entities, properties } from "@/api/db/schema";
import type { EntityKind } from "@/api/db/schema-validators";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { acquireCellLock } from "@/api/lib/cell-lock";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import {
  buildColumnFlagMutation,
  sortColumnFlagTargetsForLocking,
} from "./mark-column-flag.logic";

const TABLE_COLUMN_FLAG_EXCLUDED_ENTITY_KINDS = [
  "folder",
  "task",
] satisfies EntityKind[];

const config = {
  permissions: {
    entity: ["update"],
  },
  body: t.Object({
    propertyId: tSafeId("property"),
    flag: t.String({ minLength: 1, maxLength: 64 }),
  }),
} satisfies HandlerConfig;

type MarkColumnFlagResult =
  | {
      status: "ok";
      updatedCount: number;
    }
  | {
      status: "property-not-found";
    };

const markColumnFlag = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, user, recordAuditEvent }) {
    const txResult = yield* Result.await(
      safeDb(async (tx): Promise<MarkColumnFlagResult> => {
        const propertyRows = await tx
          .select({ id: properties.id })
          .from(properties)
          .where(
            and(
              eq(properties.id, body.propertyId),
              eq(properties.workspaceId, workspaceId),
            ),
          )
          .limit(1);
        const property = propertyRows.at(0);

        if (!property) {
          return { status: "property-not-found" };
        }

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
              notInArray(
                entities.kind,
                TABLE_COLUMN_FLAG_EXCLUDED_ENTITY_KINDS,
              ),
            ),
          )
          .orderBy(asc(entities.id))
          .for("update");

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
          return { status: "ok", updatedCount: 0 };
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
          flag: body.flag,
          targets,
          existingRows,
          userId: user.id,
          addedAt: new Date().toISOString(),
        });

        if (mutation.insertValues.length > 0) {
          await tx
            .insert(cellMetadata)
            .values(mutation.insertValues)
            .onConflictDoUpdate({
              target: [cellMetadata.entityVersionId, cellMetadata.propertyId],
              set: {
                metadata: sql`excluded.metadata`,
                updatedBy: user.id,
                updatedAt: new Date(),
              },
            });
        }

        if (mutation.auditEvents.length > 0) {
          await recordAuditEvent(tx, mutation.auditEvents);
        }

        return { status: "ok", updatedCount: mutation.updatedCount };
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

    return Result.ok({ success: true, updatedCount: txResult.updatedCount });
  },
);

export default markColumnFlag;
