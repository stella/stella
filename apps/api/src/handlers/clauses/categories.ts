import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db";
import { clauseCategories } from "@/api/db/schema";
import type { AuditRecorder, FieldDiffs } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { pickDefined } from "@/api/lib/pick-defined";

// ── Schemas ─────────────────────────────────────────

export const createCategoryBodySchema = t.Object({
  name: tDefaultVarchar,
  description: t.Optional(t.String({ maxLength: 2000 })),
  parentId: t.Optional(tSafeId("clauseCategory")),
});

export const updateCategoryBodySchema = t.Object({
  name: t.Optional(tDefaultVarchar),
  description: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
  parentId: t.Optional(t.Nullable(tSafeId("clauseCategory"))),
  sortOrder: t.Optional(t.Integer({ minimum: 0 })),
});

type CreateCategoryBody = Static<typeof createCategoryBodySchema>;
type UpdateCategoryBody = Static<typeof updateCategoryBodySchema>;

// ── List ────────────────────────────────────────────

type ListCategoriesProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
};

export const listCategoriesHandler = async function* ({
  safeDb,
  organizationId,
}: ListCategoriesProps) {
  const result = yield* Result.await(
    safeDb((tx) =>
      tx.query.clauseCategories.findMany({
        where: { organizationId: { eq: organizationId } },
        columns: {
          id: true,
          parentId: true,
          name: true,
          description: true,
          sortOrder: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { sortOrder: "asc" },
        limit: LIMITS.clauseCategoriesCount,
      }),
    ),
  );

  return Result.ok({ categories: result });
};

// ── Create ──────────────────────────────────────────

type CreateCategoryProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  body: CreateCategoryBody;
  recordAuditEvent: AuditRecorder;
};

export const createCategoryHandler = async function* ({
  safeDb,
  organizationId,
  body,
  recordAuditEvent,
}: CreateCategoryProps) {
  const existingCount = yield* Result.await(
    safeDb((tx) =>
      tx.$count(
        clauseCategories,
        eq(clauseCategories.organizationId, organizationId),
      ),
    ),
  );

  if (existingCount >= LIMITS.clauseCategoriesCount) {
    return Result.err(
      new HandlerError({ status: 400, message: "Category limit reached" }),
    );
  }

  if (body.parentId) {
    const parent = yield* Result.await(
      safeDb((tx) =>
        tx.query.clauseCategories.findFirst({
          where: {
            id: { eq: body.parentId },
            organizationId: { eq: organizationId },
          },
          columns: { id: true },
        }),
      ),
    );

    if (!parent) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Parent category not found",
        }),
      );
    }
  }

  const inserted = yield* Result.await(
    safeDb(async (tx) => {
      const [row] = await tx
        .insert(clauseCategories)
        .values({
          id: createSafeId<"clauseCategory">(),
          organizationId,
          parentId: body.parentId ?? null,
          name: body.name,
          description: body.description ?? null,
        })
        .returning({
          id: clauseCategories.id,
          parentId: clauseCategories.parentId,
          name: clauseCategories.name,
          description: clauseCategories.description,
          sortOrder: clauseCategories.sortOrder,
          createdAt: clauseCategories.createdAt,
        });

      if (row) {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.CLAUSE_CATEGORY,
          resourceId: row.id,
          changes: {
            created: {
              old: null,
              new: {
                name: row.name,
                parentId: row.parentId,
                description: row.description,
              },
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

type UpdateCategoryProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  categoryId: SafeId<"clauseCategory">;
  body: UpdateCategoryBody;
  recordAuditEvent: AuditRecorder;
};

export const updateCategoryHandler = async function* ({
  safeDb,
  organizationId,
  categoryId,
  body,
  recordAuditEvent,
}: UpdateCategoryProps) {
  const existing = yield* Result.await(
    safeDb((tx) =>
      tx.query.clauseCategories.findFirst({
        where: {
          id: { eq: categoryId },
          organizationId: { eq: organizationId },
        },
        columns: {
          id: true,
          name: true,
          description: true,
          parentId: true,
          sortOrder: true,
        },
      }),
    ),
  );

  if (!existing) {
    return Result.err(
      new HandlerError({ status: 404, message: "Category not found" }),
    );
  }

  const parentId = body.parentId;
  if (parentId) {
    if (parentId === categoryId) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Category cannot be its own parent",
        }),
      );
    }

    const parent = yield* Result.await(
      safeDb((tx) =>
        tx.query.clauseCategories.findFirst({
          where: {
            id: { eq: parentId },
            organizationId: { eq: organizationId },
          },
          columns: { id: true },
        }),
      ),
    );

    if (!parent) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Parent category not found",
        }),
      );
    }
  }

  const updates = {
    ...pickDefined(body, ["name", "description", "parentId", "sortOrder"]),
    updatedAt: new Date(),
  };

  const updated = yield* Result.await(
    safeDb(async (tx) => {
      const [row] = await tx
        .update(clauseCategories)
        .set(updates)
        .where(
          and(
            eq(clauseCategories.id, categoryId),
            eq(clauseCategories.organizationId, organizationId),
          ),
        )
        .returning({
          id: clauseCategories.id,
          parentId: clauseCategories.parentId,
          name: clauseCategories.name,
          description: clauseCategories.description,
          sortOrder: clauseCategories.sortOrder,
          updatedAt: clauseCategories.updatedAt,
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
        resourceType: AUDIT_RESOURCE_TYPE.CLAUSE_CATEGORY,
        resourceId: categoryId,
        changes,
      });

      return row;
    }),
  );

  return Result.ok(updated);
};

// ── Delete ──────────────────────────────────────────

type DeleteCategoryProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  categoryId: SafeId<"clauseCategory">;
  recordAuditEvent: AuditRecorder;
};

export const deleteCategoryHandler = async function* ({
  safeDb,
  organizationId,
  categoryId,
  recordAuditEvent,
}: DeleteCategoryProps) {
  const existing = yield* Result.await(
    safeDb((tx) =>
      tx.query.clauseCategories.findFirst({
        where: {
          id: { eq: categoryId },
          organizationId: { eq: organizationId },
        },
        columns: { id: true, name: true, parentId: true },
      }),
    ),
  );

  if (!existing) {
    return Result.err(
      new HandlerError({ status: 404, message: "Category not found" }),
    );
  }

  yield* Result.await(
    safeDb(async (tx) => {
      // Reassign children to this category's parent (or null).
      // This must happen before the delete; otherwise the FK
      // onDelete: "set null" would set children's parentId to
      // null instead of the grandparent.
      await tx
        .update(clauseCategories)
        .set({ parentId: existing.parentId ?? null })
        .where(
          and(
            eq(clauseCategories.parentId, categoryId),
            eq(clauseCategories.organizationId, organizationId),
          ),
        );

      // clauses.categoryId FK has onDelete: "set null", so
      // no manual nullification needed.
      await tx
        .delete(clauseCategories)
        .where(
          and(
            eq(clauseCategories.id, categoryId),
            eq(clauseCategories.organizationId, organizationId),
          ),
        );

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.DELETE,
        resourceType: AUDIT_RESOURCE_TYPE.CLAUSE_CATEGORY,
        resourceId: categoryId,
        changes: {
          deleted: {
            old: { name: existing.name, parentId: existing.parentId },
            new: null,
          },
        },
        metadata: { reparentedChildrenTo: existing.parentId ?? null },
      });
    }),
  );

  return Result.ok(undefined);
};
