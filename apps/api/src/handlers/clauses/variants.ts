import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db";
import { clauseVariants } from "@/api/db/schema";
import type { AuditRecorder, FieldDiffs } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { pickDefined } from "@/api/lib/pick-defined";

import { clauseBodySchema } from "./shared-schemas";

// ── Schemas ─────────────────────────────────────────

export const createVariantBodySchema = t.Object({
  label: tDefaultVarchar,
  body: clauseBodySchema,
});

export const updateVariantBodySchema = t.Object({
  label: t.Optional(tDefaultVarchar),
  body: t.Optional(clauseBodySchema),
  sortOrder: t.Optional(t.Integer({ minimum: 0 })),
});

type CreateVariantBody = Static<typeof createVariantBodySchema>;
type UpdateVariantBody = Static<typeof updateVariantBodySchema>;

// ── Helpers ─────────────────────────────────────────

const verifyClauseOwnership = async (
  safeDb: SafeDb,
  clauseId: SafeId<"clause">,
  organizationId: SafeId<"organization">,
) => {
  const result = await safeDb((tx) =>
    tx.query.clauses.findFirst({
      where: {
        id: { eq: clauseId },
        organizationId: { eq: organizationId },
      },
      columns: { id: true },
    }),
  );

  return result;
};

// ── List ────────────────────────────────────────────

type ListVariantsProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  clauseId: SafeId<"clause">;
};

export const listVariantsHandler = async function* ({
  safeDb,
  organizationId,
  clauseId,
}: ListVariantsProps) {
  const clauseResult = await verifyClauseOwnership(
    safeDb,
    clauseId,
    organizationId,
  );

  if (Result.isError(clauseResult)) {
    return yield* Result.err(clauseResult.error);
  }

  if (!clauseResult.value) {
    return Result.err(
      new HandlerError({ status: 404, message: "Clause not found" }),
    );
  }

  const result = yield* Result.await(
    safeDb((tx) =>
      tx.query.clauseVariants.findMany({
        where: {
          clauseId: { eq: clauseId },
          organizationId: { eq: organizationId },
        },
        columns: {
          id: true,
          label: true,
          body: true,
          sortOrder: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { sortOrder: "asc" },
        limit: LIMITS.clauseVariantsPerClause,
      }),
    ),
  );

  return Result.ok({ variants: result });
};

// ── Create ──────────────────────────────────────────

type CreateVariantProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  clauseId: SafeId<"clause">;
  body: CreateVariantBody;
  recordAuditEvent: AuditRecorder;
};

export const createVariantHandler = async function* ({
  safeDb,
  organizationId,
  clauseId,
  body,
  recordAuditEvent,
}: CreateVariantProps) {
  const clauseResult = await verifyClauseOwnership(
    safeDb,
    clauseId,
    organizationId,
  );

  if (Result.isError(clauseResult)) {
    return yield* Result.err(clauseResult.error);
  }

  if (!clauseResult.value) {
    return Result.err(
      new HandlerError({ status: 404, message: "Clause not found" }),
    );
  }

  const existingCount = yield* Result.await(
    safeDb((tx) =>
      tx.$count(clauseVariants, eq(clauseVariants.clauseId, clauseId)),
    ),
  );

  if (existingCount >= LIMITS.clauseVariantsPerClause) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Variant limit reached for this clause",
      }),
    );
  }

  const inserted = yield* Result.await(
    safeDb(async (tx) => {
      const [row] = await tx
        .insert(clauseVariants)
        .values({
          id: createSafeId<"clauseVariant">(),
          organizationId,
          clauseId,
          label: body.label,
          body: body.body,
        })
        .returning({
          id: clauseVariants.id,
          label: clauseVariants.label,
          sortOrder: clauseVariants.sortOrder,
          createdAt: clauseVariants.createdAt,
        });

      if (row) {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.CLAUSE_VARIANT,
          resourceId: row.id,
          changes: {
            created: {
              old: null,
              new: { clauseId, label: row.label },
            },
          },
        });
      }

      return row;
    }),
  );

  return Result.ok(inserted);
};

// ── Update ──────────────────────────────────────────

type UpdateVariantProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  clauseId: SafeId<"clause">;
  variantId: SafeId<"clauseVariant">;
  body: UpdateVariantBody;
  recordAuditEvent: AuditRecorder;
};

export const updateVariantHandler = async function* ({
  safeDb,
  organizationId,
  clauseId,
  variantId,
  body,
  recordAuditEvent,
}: UpdateVariantProps) {
  const clauseResult = await verifyClauseOwnership(
    safeDb,
    clauseId,
    organizationId,
  );

  if (Result.isError(clauseResult)) {
    return yield* Result.err(clauseResult.error);
  }

  if (!clauseResult.value) {
    return Result.err(
      new HandlerError({ status: 404, message: "Clause not found" }),
    );
  }

  const existing = yield* Result.await(
    safeDb((tx) =>
      tx.query.clauseVariants.findFirst({
        where: {
          id: { eq: variantId },
          clauseId: { eq: clauseId },
          organizationId: { eq: organizationId },
        },
        columns: { id: true, label: true, body: true, sortOrder: true },
      }),
    ),
  );

  if (!existing) {
    return Result.err(
      new HandlerError({ status: 404, message: "Variant not found" }),
    );
  }

  const updates = {
    ...pickDefined(body, ["label", "body", "sortOrder"]),
    updatedAt: new Date(),
  };

  const updated = yield* Result.await(
    safeDb(async (tx) => {
      const [row] = await tx
        .update(clauseVariants)
        .set(updates)
        .where(
          and(
            eq(clauseVariants.id, variantId),
            eq(clauseVariants.clauseId, clauseId),
          ),
        )
        .returning({
          id: clauseVariants.id,
          label: clauseVariants.label,
          sortOrder: clauseVariants.sortOrder,
          updatedAt: clauseVariants.updatedAt,
        });

      const changes: FieldDiffs = {};
      for (const [key, newValue] of Object.entries(updates)) {
        if (key === "updatedAt") {
          continue;
        }
        const oldValue = (existing as Record<string, unknown>)[key];
        if (oldValue !== newValue) {
          changes[key] = { old: oldValue ?? null, new: newValue };
        }
      }

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CLAUSE_VARIANT,
        resourceId: variantId,
        changes,
      });

      return row;
    }),
  );

  return Result.ok(updated);
};

// ── Delete ──────────────────────────────────────────

type DeleteVariantProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  clauseId: SafeId<"clause">;
  variantId: SafeId<"clauseVariant">;
  recordAuditEvent: AuditRecorder;
};

export const deleteVariantHandler = async function* ({
  safeDb,
  organizationId,
  clauseId,
  variantId,
  recordAuditEvent,
}: DeleteVariantProps) {
  const clauseResult = await verifyClauseOwnership(
    safeDb,
    clauseId,
    organizationId,
  );

  if (Result.isError(clauseResult)) {
    return yield* Result.err(clauseResult.error);
  }

  if (!clauseResult.value) {
    return Result.err(
      new HandlerError({ status: 404, message: "Clause not found" }),
    );
  }

  const existing = yield* Result.await(
    safeDb((tx) =>
      tx.query.clauseVariants.findFirst({
        where: {
          id: { eq: variantId },
          clauseId: { eq: clauseId },
          organizationId: { eq: organizationId },
        },
        columns: { id: true, label: true },
      }),
    ),
  );

  if (!existing) {
    return Result.err(
      new HandlerError({ status: 404, message: "Variant not found" }),
    );
  }

  yield* Result.await(
    safeDb(async (tx) => {
      await tx
        .delete(clauseVariants)
        .where(
          and(
            eq(clauseVariants.id, variantId),
            eq(clauseVariants.clauseId, clauseId),
          ),
        );

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.DELETE,
        resourceType: AUDIT_RESOURCE_TYPE.CLAUSE_VARIANT,
        resourceId: variantId,
        changes: {
          deleted: {
            old: { clauseId, label: existing.label },
            new: null,
          },
        },
      });
    }),
  );

  return Result.ok(undefined);
};
