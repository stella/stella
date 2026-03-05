import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";
import { nanoid } from "nanoid";

import { db } from "@/api/db";
import { templateCategories } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

// ── Schemas ─────────────────────────────────────────

export const createTemplateCategoryBodySchema = t.Object({
  name: tDefaultVarchar,
  description: t.Optional(t.String({ maxLength: 2000 })),
  parentId: t.Optional(tNanoid),
});

export const updateTemplateCategoryBodySchema = t.Object({
  name: t.Optional(tDefaultVarchar),
  description: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
  parentId: t.Optional(t.Nullable(tNanoid)),
  sortOrder: t.Optional(t.Integer({ minimum: 0 })),
});

type CreateBody = Static<typeof createTemplateCategoryBodySchema>;
type UpdateBody = Static<typeof updateTemplateCategoryBodySchema>;

// ── List ────────────────────────────────────────────

type ListProps = {
  organizationId: SafeId<"organization">;
};

export const listTemplateCategoriesHandler = async ({
  organizationId,
}: ListProps) => {
  const result = await db.query.templateCategories.findMany({
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
    limit: LIMITS.templateCategoriesCount,
  });

  return { categories: result };
};

// ── Create ──────────────────────────────────────────

type CreateProps = {
  organizationId: SafeId<"organization">;
  body: CreateBody;
};

export const createTemplateCategoryHandler = async ({
  organizationId,
  body,
}: CreateProps) => {
  const existingCount = await db.$count(
    templateCategories,
    eq(templateCategories.organizationId, organizationId),
  );

  if (existingCount >= LIMITS.templateCategoriesCount) {
    return status(400, {
      message: "Category limit reached",
    });
  }

  if (body.parentId) {
    const parent = await db.query.templateCategories.findFirst({
      where: { id: body.parentId, organizationId: { eq: organizationId } },
      columns: { id: true },
    });

    if (!parent) {
      return status(404, {
        message: "Parent category not found",
      });
    }
  }

  const [inserted] = await db
    .insert(templateCategories)
    .values({
      id: nanoid(),
      organizationId,
      parentId: body.parentId ?? null,
      name: body.name,
      description: body.description ?? null,
    })
    .returning({
      id: templateCategories.id,
      parentId: templateCategories.parentId,
      name: templateCategories.name,
      description: templateCategories.description,
      sortOrder: templateCategories.sortOrder,
      createdAt: templateCategories.createdAt,
    });

  return inserted;
};

// ── Update ──────────────────────────────────────────

type UpdateProps = {
  organizationId: SafeId<"organization">;
  categoryId: string;
  body: UpdateBody;
};

export const updateTemplateCategoryHandler = async ({
  organizationId,
  categoryId,
  body,
}: UpdateProps) => {
  const existing = await db.query.templateCategories.findFirst({
    where: { id: categoryId, organizationId: { eq: organizationId } },
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

    const parent = await db.query.templateCategories.findFirst({
      where: { id: body.parentId, organizationId: { eq: organizationId } },
      columns: { id: true, parentId: true },
    });

    if (!parent) {
      return status(404, {
        message: "Parent category not found",
      });
    }

    // Walk the ancestor chain to detect cycles
    const visited = new Set([categoryId]);
    let checkId: string | null = body.parentId;
    while (checkId) {
      if (visited.has(checkId)) {
        return status(400, {
          message: "Cannot create circular category hierarchy",
        });
      }
      visited.add(checkId);
      const ancestor: { parentId: string | null } | undefined =
        await db.query.templateCategories.findFirst({
          where: {
            id: checkId,
            organizationId: { eq: organizationId },
          },
          columns: { parentId: true },
        });
      checkId = ancestor?.parentId ?? null;
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
    .update(templateCategories)
    .set(updates)
    .where(
      and(
        eq(templateCategories.id, categoryId),
        eq(templateCategories.organizationId, organizationId),
      ),
    )
    .returning({
      id: templateCategories.id,
      parentId: templateCategories.parentId,
      name: templateCategories.name,
      description: templateCategories.description,
      sortOrder: templateCategories.sortOrder,
      updatedAt: templateCategories.updatedAt,
    });

  return updated;
};

// ── Delete ──────────────────────────────────────────

type DeleteProps = {
  organizationId: SafeId<"organization">;
  categoryId: string;
};

export const deleteTemplateCategoryHandler = async ({
  organizationId,
  categoryId,
}: DeleteProps) => {
  const existing = await db.query.templateCategories.findFirst({
    where: { id: categoryId, organizationId: { eq: organizationId } },
    columns: { id: true, parentId: true },
  });

  if (!existing) {
    return status(404, { message: "Category not found" });
  }

  await db.transaction(async (tx) => {
    // Reassign children to this category's parent (or
    // null). Must happen before the delete; otherwise the
    // FK onDelete: "set null" would null children's
    // parentId instead of promoting to grandparent.
    await tx
      .update(templateCategories)
      .set({ parentId: existing.parentId ?? null })
      .where(
        and(
          eq(templateCategories.parentId, categoryId),
          eq(templateCategories.organizationId, organizationId),
        ),
      );

    // templates.categoryId FK has onDelete: "set null",
    // so no manual nullification needed.
    await tx
      .delete(templateCategories)
      .where(
        and(
          eq(templateCategories.id, categoryId),
          eq(templateCategories.organizationId, organizationId),
        ),
      );
  });

  return;
};
