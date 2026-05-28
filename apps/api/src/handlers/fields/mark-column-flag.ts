import { Result } from "better-result";
import { and, eq, isNotNull } from "drizzle-orm";
import { t } from "elysia";

import { cellMetadata, entities, properties } from "@/api/db/schema";
import type { CellMetadata } from "@/api/db/schema-validators";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: {
    entity: ["update"],
  },
  body: t.Object({
    propertyId: tSafeId("property"),
    flag: t.String({ minLength: 1, maxLength: 64 }),
  }),
} satisfies HandlerConfig;

const normalizeManualFlags = (flags: string[]) =>
  [...new Set(flags)].toSorted();

const markColumnFlag = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, user, recordAuditEvent }) {
    const propertyResult = yield* Result.await(
      safeDb(async (tx) => {
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
        return propertyRows.at(0);
      }),
    );

    if (!propertyResult) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Property not found in workspace",
        }),
      );
    }

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
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
            ),
          );

        const targets = entityRows.flatMap((row) =>
          row.entityVersionId
            ? [
                {
                  entityId: row.entityId,
                  entityVersionId: row.entityVersionId,
                },
              ]
            : [],
        );

        if (targets.length === 0) {
          return { updatedCount: 0 };
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
              eq(cellMetadata.propertyId, body.propertyId),
            ),
          );

        const existingByVersionId = new Map(
          existingRows.map((row) => [row.entityVersionId, row.metadata]),
        );

        const addedAt = new Date().toISOString();
        const auditEvents: AuditEvent[] = [];
        let updatedCount = 0;

        for (const target of targets) {
          const existing = existingByVersionId.get(target.entityVersionId);
          const existingFlags = normalizeManualFlags(
            existing?.manualFlags ?? [],
          );
          if (existingFlags.includes(body.flag)) {
            continue;
          }
          const manualFlags = normalizeManualFlags([
            ...existingFlags,
            body.flag,
          ]);
          const existingProvenance = existing?.flagProvenance ?? {};
          const flagProvenance = Object.fromEntries(
            manualFlags.map((f) => [
              f,
              existingProvenance[f] ?? { addedBy: user.id, addedAt },
            ]),
          );
          const metadata: CellMetadata = {
            version: 1,
            manualFlags,
            flagProvenance,
            ...(existing?.locked === true && { locked: true }),
            ...(existing?.lockProvenance && {
              lockProvenance: existing.lockProvenance,
            }),
          };

          await tx
            .insert(cellMetadata)
            .values({
              workspaceId,
              entityVersionId: target.entityVersionId,
              propertyId: body.propertyId,
              metadata,
              createdBy: user.id,
              updatedBy: user.id,
            })
            .onConflictDoUpdate({
              target: [cellMetadata.entityVersionId, cellMetadata.propertyId],
              set: {
                metadata,
                updatedBy: user.id,
                updatedAt: new Date(),
              },
            });

          auditEvents.push({
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.FIELD,
            resourceId: `${target.entityVersionId}:${body.propertyId}`,
            changes: {
              manualFlags: { old: existingFlags, new: manualFlags },
            },
            metadata: {
              entityId: target.entityId,
              entityVersionId: target.entityVersionId,
              propertyId: body.propertyId,
              bulk: true,
            },
          });
          updatedCount++;
        }

        if (auditEvents.length > 0) {
          await recordAuditEvent(tx, auditEvents);
        }

        return { updatedCount };
      }),
    );

    return Result.ok({ success: true, updatedCount: txResult.updatedCount });
  },
);

export default markColumnFlag;
