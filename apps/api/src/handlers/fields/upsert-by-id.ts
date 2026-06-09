import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import type { Transaction } from "@/api/db";
import { cellMetadata, entities, fields } from "@/api/db/schema";
import type { CellMetadata } from "@/api/db/schema-validators";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditAction } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { acquireCellLock } from "@/api/lib/cell-lock";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getSearchProvider } from "@/api/lib/search/provider";

const config = {
  permissions: {
    entity: ["create", "update"],
  },
  body: t.Object({
    propertyId: tSafeId("property"),
    entityId: tSafeId("entity"),
    content: t.Union([
      t.Object({
        version: t.Literal(1),
        type: t.Literal("text"),
        value: t.String(),
      }),
      t.Object({
        version: t.Literal(1),
        type: t.Literal("single-select"),
        value: t.Nullable(t.String()),
      }),
      t.Object({
        version: t.Literal(1),
        type: t.Literal("multi-select"),
        value: t.Array(t.String({ minLength: 1 })),
      }),
      t.Object({
        version: t.Literal(1),
        type: t.Literal("date"),
        value: t.Nullable(t.String({ format: "date" })),
      }),
      t.Object({
        version: t.Literal(1),
        type: t.Literal("int"),
        value: t.Integer(),
        currency: t.Nullable(t.String({ minLength: 3, maxLength: 3 })),
      }),
      t.Object({
        version: t.Literal(1),
        type: t.Literal("clip"),
        url: t.String({ maxLength: 2048 }),
        snippet: t.Optional(t.String({ maxLength: 10_000 })),
        citation: t.Optional(t.String({ maxLength: 1000 })),
        jurisdiction: t.Optional(t.String({ maxLength: 128 })),
        sourceType: t.Optional(t.String({ maxLength: 64 })),
      }),
    ]),
  }),
} satisfies HandlerConfig;

type LockCellArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  entityVersionId: SafeId<"entityVersion">;
  propertyId: SafeId<"property">;
  userId: string;
};

const lockCellOnManualEdit = async ({
  tx,
  workspaceId,
  entityVersionId,
  propertyId,
  userId,
}: LockCellArgs) => {
  await acquireCellLock({ tx, entityVersionId, propertyId });

  const existingRows = await tx
    .select({ metadata: cellMetadata.metadata })
    .from(cellMetadata)
    .where(
      and(
        eq(cellMetadata.entityVersionId, entityVersionId),
        eq(cellMetadata.propertyId, propertyId),
      ),
    )
    .limit(1);
  const existing = existingRows.at(0)?.metadata;

  // Preserve an explicit lock so we don't overwrite its provenance/reason.
  const lockProvenance =
    existing?.locked === true
      ? existing.lockProvenance
      : {
          lockedBy: userId,
          lockedAt: new Date().toISOString(),
          reason: "manual-edit" as const,
        };

  const metadata: CellMetadata = {
    version: 1,
    manualFlags: existing?.manualFlags ?? [],
    ...(existing?.flagProvenance && {
      flagProvenance: existing.flagProvenance,
    }),
    locked: true,
    ...(lockProvenance && { lockProvenance }),
  };

  // audit: skip - caller records the manual field edit that this lock supports.
  await tx
    .insert(cellMetadata)
    .values({
      workspaceId,
      entityVersionId,
      propertyId,
      metadata,
      createdBy: userId,
      updatedBy: userId,
    })
    .onConflictDoUpdate({
      target: [cellMetadata.entityVersionId, cellMetadata.propertyId],
      set: {
        metadata,
        updatedBy: userId,
        updatedAt: new Date(),
      },
    });
};

const upsertField = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, user, recordAuditEvent }) {
    const property = yield* Result.await(
      safeDb((tx) =>
        tx.query.properties.findFirst({
          columns: { id: true, content: true },
          where: {
            id: { eq: body.propertyId },
            workspaceId: { eq: workspaceId },
          },
        }),
      ),
    );

    if (!property) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Property not found in workspace",
        }),
      );
    }

    if (property.content.type !== body.content.type) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Property content type mismatch",
        }),
      );
    }

    const isEmpty =
      body.content.value === null ||
      body.content.value === "" ||
      (Array.isArray(body.content.value) && body.content.value.length === 0);

    const reindex = () => {
      getSearchProvider().indexEntity(body.entityId).catch(captureError);
    };

    const writeResult = yield* Result.await(
      safeDb(async (tx) => {
        // Lock acquisition order (entity row → advisory cell lock)
        // must match update-cell-metadata.ts. Reversing here would
        // deadlock against a concurrent manual-flag update on the
        // same cell.
        const entityRows = await tx
          .select({
            id: entities.id,
            currentVersionId: entities.currentVersionId,
            readOnly: entities.readOnly,
          })
          .from(entities)
          .where(
            and(
              eq(entities.id, body.entityId),
              eq(entities.workspaceId, workspaceId),
            ),
          )
          .for("update");
        const entity = entityRows.at(0);

        if (!entity) {
          return { status: "entity-not-found" as const };
        }
        if (entity.readOnly) {
          return { status: "entity-read-only" as const };
        }
        if (!entity.currentVersionId) {
          panic("Entity has no current version");
        }

        const entityVersionId = entity.currentVersionId;

        await lockCellOnManualEdit({
          tx,
          workspaceId,
          entityVersionId,
          propertyId: property.id,
          userId: user.id,
        });

        const existingFieldRows = await tx
          .select({ content: fields.content })
          .from(fields)
          .where(
            and(
              eq(fields.propertyId, property.id),
              eq(fields.entityVersionId, entityVersionId),
            ),
          )
          .limit(1);
        const existingField = existingFieldRows.at(0);

        await tx
          .delete(fields)
          .where(
            and(
              eq(fields.propertyId, property.id),
              eq(fields.entityVersionId, entityVersionId),
            ),
          );

        if (!isEmpty) {
          await tx.insert(fields).values({
            workspaceId,
            propertyId: property.id,
            entityVersionId,
            content: body.content,
          });
        }

        await tx
          .update(entities)
          .set({ updatedAt: new Date() })
          .where(eq(entities.id, body.entityId));

        let action: AuditAction = AUDIT_ACTION.CREATE;
        if (isEmpty) {
          action = AUDIT_ACTION.DELETE;
        } else if (existingField) {
          action = AUDIT_ACTION.UPDATE;
        }

        await recordAuditEvent(tx, {
          action,
          resourceType: AUDIT_RESOURCE_TYPE.FIELD,
          resourceId: `${entityVersionId}:${property.id}`,
          changes: {
            content: {
              old: existingField?.content ?? null,
              new: isEmpty ? null : body.content,
            },
          },
          metadata: {
            entityId: body.entityId,
            propertyId: property.id,
            entityVersionId,
          },
        });

        return { status: "ok" as const };
      }),
    );

    if (writeResult.status === "entity-not-found") {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Entity not found in workspace",
        }),
      );
    }
    if (writeResult.status === "entity-read-only") {
      return Result.err(
        new HandlerError({ status: 409, message: "Entity is read-only" }),
      );
    }

    reindex();
    return Result.ok({});
  },
);

export default upsertField;
