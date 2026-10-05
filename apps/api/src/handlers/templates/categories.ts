import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { Transaction } from "@/api/db/root";
import { safeDbFromScoped } from "@/api/db/safe-db";
import type { SafeDbError, ScopedDb } from "@/api/db/safe-db";
import { templateCategories } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  isTreeParentGuardError,
  lockTree,
  TREE_PARENT_CYCLE_ERROR_CODE,
} from "@/api/lib/db/tree-parent-guard";
import { LIMITS } from "@/api/lib/limits";
import { pickDefined } from "@/api/lib/pick-defined";
import { isRecord } from "@/api/lib/type-guards";

// ── Hierarchy ───────────────────────────────────────

/**
 * Would re-parenting `categoryId` under `parentId` close a loop?
 *
 * One recursive walk up the chain inside the database, rather than a read per
 * level: the depth is a property of the caller's data, so a per-level read made
 * the round trips grow with how deeply a firm nests its categories.
 *
 * `path` carries the ids already seen so the walk also terminates on a cycle
 * that is already stored — a state this endpoint cannot create but must not
 * hang on — and reports it, which is what the per-level walk's `visited` set
 * did. Every row is confined to the caller's organization at both the seed and
 * the step, so a category from another firm can neither be reached nor make
 * this answer differ.
 */
const parentChainWouldCycle = async ({
  categoryId,
  organizationId,
  parentId,
  tx,
}: {
  categoryId: SafeId<"templateCategory">;
  organizationId: SafeId<"organization">;
  parentId: SafeId<"templateCategory">;
  tx: Transaction;
}): Promise<boolean> => {
  const rows = await tx.execute(sql`
      WITH RECURSIVE ancestor AS (
        SELECT seed.id, seed.parent_id, ARRAY[seed.id] AS path, false AS looped
          FROM ${templateCategories} AS seed
         WHERE seed.id = ${parentId}
           AND seed.organization_id = ${organizationId}
        UNION ALL
        SELECT step.id,
               step.parent_id,
               ancestor.path || step.id,
               step.id = ANY(ancestor.path)
          FROM ${templateCategories} AS step
          JOIN ancestor ON step.id = ancestor.parent_id
         WHERE step.organization_id = ${organizationId}
           AND NOT ancestor.looped
      )
      SELECT coalesce(
               bool_or(ancestor.looped OR ancestor.id = ${categoryId}),
               false
             ) AS cycle
        FROM ancestor
    `);

  // An aggregate over a `WITH RECURSIVE` is exactly one row carrying exactly
  // one boolean, whatever the tree looks like — `bool_or` over an empty set is
  // NULL, which the `coalesce` makes `false`. Anything else means the statement
  // is no longer the statement this reader was written for, and reading it as
  // "no cycle" would let the move through: a guard has to fail closed.
  const [row, ...extra] = executedRows(rows);
  if (extra.length > 0 || !isRecord(row) || typeof row["cycle"] !== "boolean") {
    return panic(
      "Category cycle check expected exactly one row with a boolean `cycle`",
    );
  }

  return row["cycle"];
};

// ── Schemas ─────────────────────────────────────────

export const createTemplateCategoryBodySchema = t.Object({
  name: tDefaultVarchar,
  description: t.Optional(t.String({ maxLength: 2000 })),
  parentId: t.Optional(tSafeId("templateCategory")),
});

export const updateTemplateCategoryBodySchema = t.Object({
  name: t.Optional(tDefaultVarchar),
  description: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
  parentId: t.Optional(t.Nullable(tSafeId("templateCategory"))),
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
  recordAuditEvent: AuditRecorder;
};

export const createTemplateCategoryHandler = async ({
  scopedDb,
  organizationId,
  body,
  recordAuditEvent,
}: CreateProps) => {
  if (body.parentId) {
    const parent = await scopedDb((tx) =>
      tx.query.templateCategories.findFirst({
        where: {
          id: { eq: body.parentId },
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

  // Tree lock + count + insert in one transaction to
  // prevent TOCTOU on the category limit.
  return scopedDb(async (tx) => {
    await lockTree(tx, {
      tree: "templateCategories",
      scopeId: organizationId,
    });

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
        id: createSafeId<"templateCategory">(),
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

    if (!inserted) {
      panic("Failed to create template category");
    }

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
      resourceId: inserted.id,
      metadata: {
        kind: "template-category",
        name: inserted.name,
        parentId: inserted.parentId,
      },
    });

    return inserted;
  });
};

// ── Update ──────────────────────────────────────────

const CIRCULAR_CATEGORY_MESSAGE = "Cannot create circular category hierarchy";

const circularCategory = () =>
  status(400, {
    code: TREE_PARENT_CYCLE_ERROR_CODE,
    message: CIRCULAR_CATEGORY_MESSAGE,
  });

/**
 * Run a parent change under the tree lock, answering the database guard's
 * refusal with the same 400 the pre-check gives. Any other failure is returned
 * unchanged as the transaction's error.
 */
const withCategoryTree = async <T>(
  scopedDb: ScopedDb,
  organizationId: SafeId<"organization">,
  run: (tx: Transaction) => Promise<T>,
): Promise<Result<T | ReturnType<typeof circularCategory>, SafeDbError>> => {
  const attempt = await safeDbFromScoped(scopedDb)(async (tx) => {
    await lockTree(tx, {
      tree: "templateCategories",
      scopeId: organizationId,
    });
    return await run(tx);
  });
  if (
    attempt.isErr() &&
    isTreeParentGuardError(attempt.error, "templateCategories")
  ) {
    return Result.ok(circularCategory());
  }
  return attempt;
};

type UpdateProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  categoryId: SafeId<"templateCategory">;
  body: UpdateBody;
  recordAuditEvent: AuditRecorder;
};

export const updateTemplateCategoryHandler = async ({
  scopedDb,
  organizationId,
  categoryId,
  body,
  recordAuditEvent,
}: UpdateProps) =>
  // The tree lock comes first, so the parent check, the cycle check and the
  // write see one tree: a concurrent reparent waits and then reads this one's
  // result. The `template_categories_parent_acyclic` trigger holds the same
  // rule for any writer that skips the lock.
  await withCategoryTree(scopedDb, organizationId, async (tx) => {
    const existing = await tx.query.templateCategories.findFirst({
      where: { id: { eq: categoryId }, organizationId: { eq: organizationId } },
      columns: { id: true },
    });

    if (!existing) {
      return status(404, { message: "Category not found" });
    }

    const parentId = body.parentId;
    if (parentId) {
      if (parentId === categoryId) {
        return status(400, {
          code: TREE_PARENT_CYCLE_ERROR_CODE,
          message: "Category cannot be its own parent",
        });
      }

      const parent = await tx.query.templateCategories.findFirst({
        where: { id: { eq: parentId }, organizationId: { eq: organizationId } },
        columns: { id: true, parentId: true },
      });

      if (!parent) {
        return status(404, {
          message: "Parent category not found",
        });
      }

      if (
        await parentChainWouldCycle({
          categoryId,
          organizationId,
          parentId,
          tx,
        })
      ) {
        return circularCategory();
      }
    }

    const updates = {
      ...pickDefined(body, ["name", "description", "parentId", "sortOrder"]),
      updatedAt: new Date(),
    };

    const rows = await tx
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

    const updated = rows.at(0);
    if (!updated) {
      return panic("Failed to update template category");
    }

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
      resourceId: categoryId,
      metadata: {
        kind: "template-category",
        fields: Object.keys(updates),
      },
    });

    return updated;
  });

// ── Delete ──────────────────────────────────────────

type DeleteProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  categoryId: SafeId<"templateCategory">;
  recordAuditEvent: AuditRecorder;
};

export const deleteTemplateCategoryHandler = async ({
  scopedDb,
  organizationId,
  categoryId,
  recordAuditEvent,
}: DeleteProps) =>
  // Under the tree lock the parent read here is the one the children move to:
  // a concurrent reparent of this category either committed before (and is
  // read) or waits until the delete commits.
  await withCategoryTree(scopedDb, organizationId, async (tx) => {
    const existing = await tx.query.templateCategories.findFirst({
      where: { id: { eq: categoryId }, organizationId: { eq: organizationId } },
      columns: { id: true, parentId: true },
    });

    if (!existing) {
      return status(404, { message: "Category not found" });
    }

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

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.DELETE,
      resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
      resourceId: categoryId,
      metadata: {
        kind: "template-category",
        reparentedTo: existing.parentId ?? null,
      },
    });

    return {};
  });
