import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { PermissionInput } from "@stll/permissions";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { abortableTx, abortTransaction } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import { cellMetadata, entities, fields } from "@/api/db/schema";
import { currencyCodeSchema } from "@/api/db/schema-validators";
import type { CellMetadata } from "@/api/db/schema-validators";
import { captureError } from "@/api/lib/analytics/capture";
import { arrayOrEmpty } from "@/api/lib/array";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditAction, AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { acquireCellLock } from "@/api/lib/cell-lock";
import { tUserId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { VERSION_CONFLICT_ERROR_CODE } from "@/api/lib/optimistic-concurrency";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { flushEntitySearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueEntitySearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { enforceWritePrecondition } from "@/api/lib/write-contract";

/**
 * The single writer of a person's own field value (one document cell). Every
 * surface that sets a cell on a member's behalf (REST, MCP, Kanban moves,
 * chat) calls `writeFieldValue`, so the authority check, the manual-edit cell
 * lock, the lock order, the write and its audit event cannot differ between
 * them. Direct writes to the field tables elsewhere are refused by the
 * `no-direct-field-write` lint rule.
 */

/** What a member's credential must grant to set a cell. */
export const FIELD_VALUE_WRITE_PERMISSIONS = {
  entity: ["create", "update"],
} satisfies PermissionInput;

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

export type FieldWriteContent = Static<typeof upsertFieldContentSchema>;

export const INTERNAL_FIELD_WRITE_PRECONDITION = "internal" as const;
const ABSENT_ROW_UPDATED_AT = new Date(0);
const ABSENT_ROW_EXPECTED_UPDATED_AT = ABSENT_ROW_UPDATED_AT.toISOString();

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
          lockedAt: Temporal.Now.instant().toString({
            fractionalSecondDigits: 3,
          }),
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

// What counts as an empty cell is per content type. A clip cannot reach here
// (property content types never include clip), and the variants that carry no
// `value` answer for themselves: a money amount of zero is an amount, and a
// person is empty only when unnamed.
const isEmptyContent = (content: FieldWriteContent): boolean => {
  switch (content.type) {
    case "text":
    case "single-select":
    case "date":
      return content.value === null || content.value === "";
    case "multi-select":
      return content.value.length === 0;
    case "person":
      return content.name === "";
    case "int":
    case "money":
    case "clip":
      return false;
    default:
      content satisfies never;
      return panic("Unhandled field content type");
  }
};

type ReplaceStoredFieldOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  propertyId: SafeId<"property">;
  entityVersionId: SafeId<"entityVersion">;
  content: FieldWriteContent | null;
  previousContent: (typeof fields.$inferSelect)["content"] | undefined;
  entityId: SafeId<"entity">;
  entityKind: (typeof entities.$inferSelect)["kind"];
  recordAuditEvent: AuditRecorder;
};

/** Called under the entity and cell locks; a create must never replace another writer. */
const replaceStoredField = async ({
  tx,
  workspaceId,
  propertyId,
  entityVersionId,
  content,
  previousContent,
  entityId,
  entityKind,
  recordAuditEvent,
}: ReplaceStoredFieldOptions) => {
  const cellPredicate = and(
    eq(fields.propertyId, propertyId),
    eq(fields.entityVersionId, entityVersionId),
    eq(fields.workspaceId, workspaceId),
  );
  if (content === null) {
    await tx.delete(fields).where(cellPredicate);
  } else if (previousContent === undefined) {
    const inserted = await tx
      .insert(fields)
      .values({
        workspaceId,
        propertyId,
        entityVersionId,
        content,
      })
      .onConflictDoNothing({
        target: [fields.propertyId, fields.entityVersionId],
      })
      .returning({ id: fields.id });
    if (inserted.length === 0) {
      return abortTransaction(
        new HandlerError({
          code: VERSION_CONFLICT_ERROR_CODE,
          status: 409,
          message:
            "Field value changed while it was being edited; reload and try again",
        }),
      );
    }
  } else {
    await tx.update(fields).set({ content, fileId: null }).where(cellPredicate);
  }

  let action: AuditAction = AUDIT_ACTION.CREATE;
  if (content === null) {
    action = AUDIT_ACTION.DELETE;
  } else if (previousContent !== undefined) {
    action = AUDIT_ACTION.UPDATE;
  }

  await recordAuditEvent(tx, {
    action,
    resourceType: AUDIT_RESOURCE_TYPE.FIELD,
    resourceId: `${entityVersionId}:${propertyId}`,
    changes: {
      content: {
        old: previousContent ?? null,
        new: content,
      },
    },
    metadata: {
      entityId,
      kind: entityKind,
      propertyId,
      entityVersionId,
    },
    // The cell's own matter, whichever matter the recorder is bound to
    // (a chat turn may write into any matter it is authorized for).
    workspaceId,
  });

  const updatedEntity = (
    await tx
      .update(entities)
      .set({ updatedAt: sql`clock_timestamp()` })
      .where(
        and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId)),
      )
      .returning({ updatedAt: entities.updatedAt })
  ).at(0);
  if (updatedEntity === undefined || updatedEntity.updatedAt === null) {
    return panic("Locked field entity did not return updatedAt");
  }

  return updatedEntity.updatedAt;
};

export type WriteFieldValueProps = {
  safeDb: SafeDb;
  /** The caller's effective authority (role plus credential attenuation). */
  authority: AuthorizedMemberRole;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  entityId: SafeId<"entity">;
  propertyId: SafeId<"property">;
  /**
   * The value to store. An empty value, or `null`, clears the cell; `null`
   * clears a cell whose type has no empty value (an `int`).
   */
  content: FieldWriteContent | null;
  /** Null declares that the cell was absent when the caller read it. */
  expectedUpdatedAt: string | null | typeof INTERNAL_FIELD_WRITE_PRECONDITION;
  flushSearchRepairs?: boolean;
};

/**
 * Sets one cell for a member: checks the member's authority, takes the entity
 * row lock and then the cell lock (the order `update-cell-metadata.ts` uses),
 * marks the cell as manually edited, replaces the value and records the FIELD
 * audit event, all in one transaction.
 *
 * @yields A failed database read or write, ending the write.
 */
export const writeFieldValue = async function* ({
  safeDb,
  authority,
  workspaceId,
  userId,
  recordAuditEvent,
  entityId,
  propertyId,
  content,
  expectedUpdatedAt,
  flushSearchRepairs = true,
}: WriteFieldValueProps) {
  if (!hasMemberPermission(authority, FIELD_VALUE_WRITE_PERMISSIONS)) {
    return Result.err(new HandlerError({ status: 403, message: "Forbidden" }));
  }

  const property = yield* Result.await(
    safeDb((tx) =>
      tx.query.properties.findFirst({
        columns: { id: true, content: true },
        where: {
          id: { eq: propertyId },
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

  if (content !== null && property.content.type !== content.type) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Property content type mismatch",
      }),
    );
  }

  const storedContent =
    content === null || isEmptyContent(content) ? null : content;

  const writeResult = yield* Result.await(
    abortableTx(safeDb, async (tx) => {
      const entityRows = await tx
        .select({
          id: entities.id,
          currentVersionId: entities.currentVersionId,
          kind: entities.kind,
          readOnly: entities.readOnly,
          updatedAt: entities.updatedAt,
        })
        .from(entities)
        .where(
          and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId)),
        )
        .for("update");
      const entity = entityRows.at(0);

      if (!entity) {
        return abortTransaction(
          new HandlerError({
            status: 404,
            message: "Entity not found in workspace",
          }),
        );
      }
      if (entity.readOnly) {
        return abortTransaction(
          new HandlerError({ status: 409, message: "Entity is read-only" }),
        );
      }
      if (!entity.currentVersionId) {
        return abortTransaction(
          new HandlerError({
            status: 404,
            message: "Entity has no current version",
          }),
        );
      }

      const entityVersionId = entity.currentVersionId;
      await acquireCellLock({ tx, entityVersionId, propertyId: property.id });

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

      const storedUpdatedAt =
        existingField === undefined
          ? ABSENT_ROW_UPDATED_AT
          : (entity.updatedAt ?? ABSENT_ROW_UPDATED_AT);
      const expected =
        expectedUpdatedAt === INTERNAL_FIELD_WRITE_PRECONDITION
          ? storedUpdatedAt.toISOString()
          : (expectedUpdatedAt ?? ABSENT_ROW_EXPECTED_UPDATED_AT);
      const conflict = enforceWritePrecondition({
        type: "updatedAt",
        field: "expectedUpdatedAt",
        storedUpdatedAt,
        expectedUpdatedAt: expected,
        resource: "Field value",
      });
      if (conflict !== null) {
        return abortTransaction(conflict);
      }

      const updatedAt = await replaceStoredField({
        tx,
        workspaceId,
        propertyId: property.id,
        entityVersionId,
        content: storedContent,
        previousContent: existingField?.content,
        entityId,
        entityKind: entity.kind,
        recordAuditEvent,
      });

      await lockCellOnManualEdit({
        tx,
        workspaceId,
        entityVersionId,
        propertyId: property.id,
        userId,
      });

      await enqueueEntitySearchRepairs(tx, [entityId]);

      return { updatedAt };
    }),
  );

  if (flushSearchRepairs) {
    flushEntitySearchRepairs([entityId]).catch(captureError);
  }
  return Result.ok({ updatedAt: writeResult.updatedAt });
};
