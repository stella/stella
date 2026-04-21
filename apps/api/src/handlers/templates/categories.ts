import { and, eq, sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { templateCategories } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tUuid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { pickDefined } from "@/api/lib/pick-defined";

// ── Schemas ─────────────────────────────────────────

export const createTemplateCategoryBodySchema = t.Object({
  name: tDefaultVarchar,
  description: t.Optional(t.String({ maxLength: 2000 })),
  parentId: t.Optional(tUuid),
});

export const updateTemplateCategoryBodySchema = t.Object({
  name: t.Optional(tDefaultVarchar),
  description: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
  parentId: t.Optional(t.Nullable(tUuid)),
  sortOrder: t.Optional(t.Integer({ minimum: 0 })),
});

type CreateBody = Static<typeof createTemplateCategoryBodySchema>;
type UpdateBody = Static<typeof updateTemplateCategoryBodySchema>;

// ── List ────────────────────────────────────────────

type ListProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
};

export const listTemplateCategoriesHandler = async ({
  scopedDb,
  organizationId,
}: ListProps) => {
  const result = await scopedDb((tx) =>
    tx.query.templateCategories.findMany({
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
    }),
  );

  return { categories: result };
};

// ── Create ──────────────────────────────────────────

type CreateProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  body: CreateBody;
};

export const createTemplateCategoryHandler = async ({
  scopedDb,
  organizationId,
  body,
}: CreateProps) => {
  if (body.parentId) {
    const parent = await scopedDb((tx) =>
      tx.query.templateCategories.findFirst({
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

  // Advisory lock + count + insert in one transaction to
  // prevent TOCTOU on the category limit.
  return scopedDb(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`,
    );

    const existingCount = await tx.$count(
      templateCategories,
      eq(templateCategories.organizationId, organizationId),
    );

    if (existingCount >= LIMITS.templateCategoriesCount) {
      return status(400, {
        message: "Category limit reached",
      });
    }

    const [inserted] = await tx
      .insert(templateCategories)
      .values({
        id: crypto.randomUUID(),
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
  });
};

// ── Update ──────────────────────────────────────────

type UpdateProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  categoryId: string;
  body: UpdateBody;
};

export const updateTemplateCategoryHandler = async ({
  scopedDb,
  organizationId,
  categoryId,
  body,
}: UpdateProps) => {
  const existing = await scopedDb((tx) =>
    tx.query.templateCategories.findFirst({
      where: { id: categoryId, organizationId: { eq: organizationId } },
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
      tx.query.templateCategories.findFirst({
        where: { id: parentId, organizationId: { eq: organizationId } },
        columns: { id: true, parentId: true },
      }),
    );

    if (!parent) {
      return status(404, {
        message: "Parent category not found",
      });
    }

    // Walk the ancestor chain to detect cycles
    const visited = new Set([categoryId]);
    let checkId: string | null = parentId;
    while (checkId) {
      if (visited.has(checkId)) {
        return status(400, {
          message: "Cannot create circular category hierarchy",
        });
      }
      visited.add(checkId);
      const currentId: string = checkId;
      const ancestor: { parentId: string | null } | undefined = await scopedDb(
        (tx) =>
          tx.query.templateCategories.findFirst({
            where: {
              id: currentId,
              organizationId: { eq: organizationId },
            },
            columns: { parentId: true },
          }),
      );
      checkId = ancestor?.parentId ?? null;
    }
  }

  const updates = {
    ...pickDefined(body, ["name", "description", "parentId", "sortOrder"]),
    updatedAt: new Date(),
  };

  const [updated] = await scopedDb((tx) =>
    tx
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
      }),
  );

  return updated;
};

// ── Delete ──────────────────────────────────────────

type DeleteProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  categoryId: string;
};

export const deleteTemplateCategoryHandler = async ({
  scopedDb,
  organizationId,
  categoryId,
}: DeleteProps) => {
  const existing = await scopedDb((tx) =>
    tx.query.templateCategories.findFirst({
      where: { id: categoryId, organizationId: { eq: organizationId } },
      columns: { id: true, parentId: true },
    }),
  );

  if (!existing) {
    return status(404, { message: "Category not found" });
  }

  await scopedDb(async (tx) => {
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

  return undefined;
};
