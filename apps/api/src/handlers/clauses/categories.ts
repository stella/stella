import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db";
import { clauseCategories } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tUuid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { pickDefined } from "@/api/lib/pick-defined";

// ── Schemas ─────────────────────────────────────────

export const createCategoryBodySchema = t.Object({
  name: tDefaultVarchar,
  description: t.Optional(t.String({ maxLength: 2000 })),
  parentId: t.Optional(tUuid),
});

export const updateCategoryBodySchema = t.Object({
  name: t.Optional(tDefaultVarchar),
  description: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
  parentId: t.Optional(t.Nullable(tUuid)),
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
};

export const createCategoryHandler = async function* ({
  safeDb,
  organizationId,
  body,
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
            id: body.parentId,
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

  const [inserted] = yield* Result.await(
    safeDb((tx) =>
      tx
        .insert(clauseCategories)
        .values({
          id: crypto.randomUUID(),
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
        }),
    ),
  );

  return Result.ok(inserted);
};

// ── Update ──────────────────────────────────────────

type UpdateCategoryProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  categoryId: string;
  body: UpdateCategoryBody;
};

export const updateCategoryHandler = async function* ({
  safeDb,
  organizationId,
  categoryId,
  body,
}: UpdateCategoryProps) {
  const existing = yield* Result.await(
    safeDb((tx) =>
      tx.query.clauseCategories.findFirst({
        where: {
          id: categoryId,
          organizationId: { eq: organizationId },
        },
        columns: { id: true },
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
            id: parentId,
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

  const [updated] = yield* Result.await(
    safeDb((tx) =>
      tx
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
        }),
    ),
  );

  return Result.ok(updated);
};

// ── Delete ──────────────────────────────────────────

type DeleteCategoryProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  categoryId: string;
};

export const deleteCategoryHandler = async function* ({
  safeDb,
  organizationId,
  categoryId,
}: DeleteCategoryProps) {
  const existing = yield* Result.await(
    safeDb((tx) =>
      tx.query.clauseCategories.findFirst({
        where: {
          id: categoryId,
          organizationId: { eq: organizationId },
        },
        columns: { id: true, parentId: true },
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
    }),
  );

  return Result.ok(undefined);
};
