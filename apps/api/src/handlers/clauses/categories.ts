import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { clauseCategories } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { pickDefined } from "@/api/lib/pick-defined";

// ── Schemas ─────────────────────────────────────────

export const createCategoryBodySchema = t.Object({
  name: tDefaultVarchar,
  description: t.Optional(t.String({ maxLength: 2000 })),
  parentId: t.Optional(tNanoid),
});

export const updateCategoryBodySchema = t.Object({
  name: t.Optional(tDefaultVarchar),
  description: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
  parentId: t.Optional(t.Nullable(tNanoid)),
  sortOrder: t.Optional(t.Integer({ minimum: 0 })),
});

type CreateCategoryBody = Static<typeof createCategoryBodySchema>;
type UpdateCategoryBody = Static<typeof updateCategoryBodySchema>;

// ── List ────────────────────────────────────────────

type ListCategoriesProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
};

export const listCategoriesHandler = async ({
  scopedDb,
  organizationId,
}: ListCategoriesProps) => {
  const result = await scopedDb((tx) =>
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
  );

  return { categories: result };
};

// ── Create ──────────────────────────────────────────

type CreateCategoryProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  body: CreateCategoryBody;
};

export const createCategoryHandler = async ({
  scopedDb,
  organizationId,
  body,
}: CreateCategoryProps) => {
  const existingCount = await scopedDb((tx) =>
    tx.$count(
      clauseCategories,
      eq(clauseCategories.organizationId, organizationId),
    ),
  );

  if (existingCount >= LIMITS.clauseCategoriesCount) {
    return status(400, {
      message: "Category limit reached",
    });
  }

  if (body.parentId) {
    const parent = await scopedDb((tx) =>
      tx.query.clauseCategories.findFirst({
        where: {
          id: body.parentId,
          organizationId: { eq: organizationId },
        },
        columns: { id: true },
      }),
    );

    if (!parent) {
      return status(404, {
        message: "Parent category not found",
      });
    }
  }

  const [inserted] = await scopedDb((tx) =>
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
  );

  return inserted;
};

// ── Update ──────────────────────────────────────────

type UpdateCategoryProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  categoryId: string;
  body: UpdateCategoryBody;
};

export const updateCategoryHandler = async ({
  scopedDb,
  organizationId,
  categoryId,
  body,
}: UpdateCategoryProps) => {
  const existing = await scopedDb((tx) =>
    tx.query.clauseCategories.findFirst({
      where: {
        id: categoryId,
        organizationId: { eq: organizationId },
      },
      columns: { id: true },
    }),
  );

  if (!existing) {
    return status(404, { message: "Category not found" });
  }

  const parentId = body.parentId;
  if (parentId) {
    if (parentId === categoryId) {
      return status(400, {
        message: "Category cannot be its own parent",
      });
    }

    const parent = await scopedDb((tx) =>
      tx.query.clauseCategories.findFirst({
        where: {
          id: parentId,
          organizationId: { eq: organizationId },
        },
        columns: { id: true },
      }),
    );

    if (!parent) {
      return status(404, {
        message: "Parent category not found",
      });
    }
  }

  const updates = {
    ...pickDefined(body, ["name", "description", "parentId", "sortOrder"]),
    updatedAt: new Date(),
  };

  const [updated] = await scopedDb((tx) =>
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
  );

  return updated;
};

// ── Delete ──────────────────────────────────────────

type DeleteCategoryProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  categoryId: string;
};

export const deleteCategoryHandler = async ({
  scopedDb,
  organizationId,
  categoryId,
}: DeleteCategoryProps) => {
  const existing = await scopedDb((tx) =>
    tx.query.clauseCategories.findFirst({
      where: {
        id: categoryId,
        organizationId: { eq: organizationId },
      },
      columns: { id: true, parentId: true },
    }),
  );

  if (!existing) {
    return status(404, { message: "Category not found" });
  }

  await scopedDb(async (tx) => {
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
  });

  return undefined;
};
