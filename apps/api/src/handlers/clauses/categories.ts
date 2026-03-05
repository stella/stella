import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";
import { nanoid } from "nanoid";

import { db } from "@/api/db";
import { clauseCategories } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

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
  organizationId: SafeId<"organization">;
};

export const listCategoriesHandler = async ({
  organizationId,
}: ListCategoriesProps) => {
  const result = await db.query.clauseCategories.findMany({
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
  });

  return { categories: result };
};

// ── Create ──────────────────────────────────────────

type CreateCategoryProps = {
  organizationId: SafeId<"organization">;
  body: CreateCategoryBody;
};

export const createCategoryHandler = async ({
  organizationId,
  body,
}: CreateCategoryProps) => {
  const existingCount = await db.$count(
    clauseCategories,
    eq(clauseCategories.organizationId, organizationId),
  );

  if (existingCount >= LIMITS.clauseCategoriesCount) {
    return status(400, {
      message: "Category limit reached",
    });
  }

  if (body.parentId) {
    const parent = await db.query.clauseCategories.findFirst({
      where: {
        id: body.parentId,
        organizationId: { eq: organizationId },
      },
      columns: { id: true },
    });

    if (!parent) {
      return status(404, {
        message: "Parent category not found",
      });
    }
  }

  const [inserted] = await db
    .insert(clauseCategories)
    .values({
      id: nanoid(),
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

  return inserted;
};

// ── Update ──────────────────────────────────────────

type UpdateCategoryProps = {
  organizationId: SafeId<"organization">;
  categoryId: string;
  body: UpdateCategoryBody;
};

export const updateCategoryHandler = async ({
  organizationId,
  categoryId,
  body,
}: UpdateCategoryProps) => {
  const existing = await db.query.clauseCategories.findFirst({
    where: {
      id: categoryId,
      organizationId: { eq: organizationId },
    },
    columns: { id: true },
  });

  if (!existing) {
    return status(404, { message: "Category not found" });
  }

  if (body.parentId) {
    if (body.parentId === categoryId) {
      return status(400, {
        message: "Category cannot be its own parent",
      });
    }

    const parent = await db.query.clauseCategories.findFirst({
      where: {
        id: body.parentId,
        organizationId: { eq: organizationId },
      },
      columns: { id: true },
    });

    if (!parent) {
      return status(404, {
        message: "Parent category not found",
      });
    }
  }

  const updates: Partial<{
    name: string;
    description: string | null;
    parentId: string | null;
    sortOrder: number;
    updatedAt: Date;
  }> = { updatedAt: new Date() };

  if (body.name !== undefined) {
    updates.name = body.name;
  }
  if (body.description !== undefined) {
    updates.description = body.description;
  }
  if (body.parentId !== undefined) {
    updates.parentId = body.parentId;
  }
  if (body.sortOrder !== undefined) {
    updates.sortOrder = body.sortOrder;
  }

  const [updated] = await db
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

  return updated;
};

// ── Delete ──────────────────────────────────────────

type DeleteCategoryProps = {
  organizationId: SafeId<"organization">;
  categoryId: string;
};

export const deleteCategoryHandler = async ({
  organizationId,
  categoryId,
}: DeleteCategoryProps) => {
  const existing = await db.query.clauseCategories.findFirst({
    where: {
      id: categoryId,
      organizationId: { eq: organizationId },
    },
    columns: { id: true, parentId: true },
  });

  if (!existing) {
    return status(404, { message: "Category not found" });
  }

  await db.transaction(async (tx) => {
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

  return;
};
