import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { cellMetadata, entities, fields } from "@/api/db/schema";
import { currencyCodeSchema } from "@/api/db/schema-validators";
import type { CellMetadata } from "@/api/db/schema-validators";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditAction, AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { acquireCellLock } from "@/api/lib/cell-lock";
import { tSafeId, tUserId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  enqueueEntitySearchRepairs,
  flushEntitySearchRepairs,
} from "@/api/lib/search/projection-repair-queue";

export const upsertFieldContentSchema = t.Union(
  [
    t.Object({
      version: t.Literal(1),
      type: t.Literal("text", {
        description: "Value type; must match the property's value type",
      }),
      value: t.String(),
    }),
    t.Object({
      version: t.Literal(1),
      type: t.Literal("single-select", {
        description: "Value type; must match the property's value type",
      }),
      value: t.Nullable(t.String()),
    }),
    t.Object({
      version: t.Literal(1),
      type: t.Literal("multi-select", {
        description: "Value type; must match the property's value type",
      }),
      value: t.Array(t.String({ minLength: 1 })),
    }),
    t.Object({
      version: t.Literal(1),
      type: t.Literal("date", {
        description: "Value type; must match the property's value type",
      }),
      value: t.Nullable(t.String({ format: "date" })),
    }),
    t.Object({
      version: t.Literal(1),
      type: t.Literal("int", {
        description: "Value type; must match the property's value type",
      }),
      value: t.Integer(),
      currency: t.Nullable(
        currencyCodeSchema(
          "For int values only: 3-letter ISO currency code, or null",
        ),
      ),
    }),
    t.Object({
      version: t.Literal(1),
      type: t.Literal("money", {
        description: "Value type; must match the property's value type",
      }),
      amountCents: t.Integer({
        description: "Amount in the currency's minor units",
      }),
      currency: currencyCodeSchema("3-letter ISO currency code"),
    }),
    t.Object({
      version: t.Literal(1),
      type: t.Literal("person", {
        description: "Empty person sentinel that clears the property value",
      }),
      userId: t.Null(),
      name: t.Literal(""),
      image: t.Null(),
    }),
    t.Object({
      version: t.Literal(1),
      type: t.Literal("person", {
        description: "Value type; must match the property's value type",
      }),
      userId: t.Nullable(tUserId),
      name: t.String({ minLength: 1, maxLength: 256 }),
      image: t.Nullable(t.String({ maxLength: 2048 })),
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
  ],
  { description: "The value to set; 'type' must match the property." },
);

const config = {
  description:
    "Set a document's value for a property (a cell in the matter's table). " +
    "Pass the document entityId, the propertyId (from list_properties), and " +
    "a content object whose 'type' matches the property's value type: text " +
    "(value: string), single-select (value: string or null), multi-select " +
    "(value: array of strings), date (value: ISO YYYY-MM-DD or null), or int " +
    "(value: integer, optional currency: 3-letter ISO code). An empty value " +
    "clears the cell.",
  permissions: {
    entity: ["create", "update"],
  },
  mcp: { type: "tool", name: "set_field_value" },
  body: t.Object({
    propertyId: tSafeId("property", {
      description: "Property ID, as returned by list_properties",
    }),
    entityId: tSafeId("entity", {
      description: "Document entity ID whose cell to set",
    }),
    content: upsertFieldContentSchema,
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
    manualFlags: arrayOrEmpty(existing?.manualFlags),
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

type UpsertFieldBody = Static<(typeof config)["body"]>;

export type UpsertFieldContent = UpsertFieldBody["content"];

type UpsertFieldHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  body: UpsertFieldBody;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  flushSearchRepairs?: boolean;
};

export const upsertFieldHandler = async function* ({
  safeDb,
  workspaceId,
  body,
  userId,
  recordAuditEvent,
  flushSearchRepairs = true,
}: UpsertFieldHandlerProps) {
  const user = { id: userId };
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

  // What counts as an empty cell is per content type. A clip cannot reach here
  // (property content types never include clip), and the variants that carry no
  // `value` answer for themselves: a money amount of zero is an amount, and a
  // person is empty only when unnamed.
  const isEmpty = ((): boolean => {
    switch (body.content.type) {
      case "text":
      case "single-select":
      case "date":
        return body.content.value === null || body.content.value === "";
      case "multi-select":
        return body.content.value.length === 0;
      case "person":
        return body.content.name === "";
      case "int":
      case "money":
        return false;
      default:
        return false;
    }
  })();

  const reindex = () => {
    flushEntitySearchRepairs([body.entityId]).catch(captureError);
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
          kind: entities.kind,
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
          kind: entity.kind,
          propertyId: property.id,
          entityVersionId,
        },
      });

      await enqueueEntitySearchRepairs(tx, [body.entityId]);

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

  if (flushSearchRepairs) {
    reindex();
  }
  return Result.ok({});
};

const upsertField = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, user, recordAuditEvent }) {
    return yield* upsertFieldHandler({
      safeDb,
      workspaceId,
      body,
      userId: user.id,
      recordAuditEvent,
    });
  },
);

export default upsertField;
