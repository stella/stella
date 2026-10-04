import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { clauseCategories } from "@/api/db/schema";
import type { AuditRecorder, FieldDiffs } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import {
  isTreeParentGuardError,
  lockTree,
  treeParentCycleError,
} from "@/api/lib/db/tree-parent-guard";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { pickDefined } from "@/api/lib/pick-defined";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

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

type CategoryRow = typeof clauseCategories.$inferSelect;

const UNPROJECTED_CATEGORY_COLUMNS = [
  // Tenant scope is fixed by the active organization.
  "organizationId",
] as const satisfies readonly (keyof CategoryRow)[];

const CATEGORY_LIST_COLUMNS = {
  id: true,
  parentId: true,
  name: true,
  description: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const;

type MissingCategoryListColumn = UnprojectedColumns<
  CategoryRow,
  typeof CATEGORY_LIST_COLUMNS,
  (typeof UNPROJECTED_CATEGORY_COLUMNS)[number]
>;
type UnexpectedCategoryListColumn = UnbackedProjectionKeys<
  CategoryRow,
  typeof CATEGORY_LIST_COLUMNS,
  (typeof UNPROJECTED_CATEGORY_COLUMNS)[number]
>;

true satisfies MissingCategoryListColumn extends never ? true : never;
true satisfies UnexpectedCategoryListColumn extends never ? true : never;

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
        columns: CATEGORY_LIST_COLUMNS,
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

  if (!inserted) {
    panic("Failed to create clause category");
  }

  return Result.ok(inserted);
};

// ── Update ──────────────────────────────────────────

const CIRCULAR_CATEGORY_MESSAGE = "Cannot create circular category hierarchy";

type UpdatedCategory = Pick<
  typeof clauseCategories.$inferSelect,
  "id" | "parentId" | "name" | "description" | "sortOrder" | "updatedAt"
>;

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
  const parentId = body.parentId;

  // The tree lock comes first, so the parent check, the cycle check and the
  // write see one tree: a concurrent reparent waits here and then reads this
  // one's result. The `clause_categories_parent_acyclic` trigger holds the
  // same rule for any writer that skips the lock.
  const attempt = await safeDb(
    async (tx): Promise<Result<UpdatedCategory, HandlerError>> => {
      await lockTree(tx, {
        tree: "clauseCategories",
        scopeId: organizationId,
      });

      const existing = await tx.query.clauseCategories.findFirst({
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
      });
      if (!existing) {
        return Result.err(
          new HandlerError({ status: 404, message: "Category not found" }),
        );
      }

      if (parentId) {
        if (parentId === categoryId) {
          return Result.err(
            treeParentCycleError("Category cannot be its own parent"),
          );
        }

        const parent = await tx.query.clauseCategories.findFirst({
          where: {
            id: { eq: parentId },
            organizationId: { eq: organizationId },
          },
          columns: { id: true },
        });
        if (!parent) {
          return Result.err(
            new HandlerError({
              status: 404,
              message: "Parent category not found",
            }),
          );
        }

        const result = await tx.execute<{ found: boolean }>(sql`
          WITH RECURSIVE ancestors(id, parent_id) AS (
            SELECT category.id, category.parent_id
            FROM ${clauseCategories} category
            WHERE category.id = ${parentId}
              AND category.organization_id = ${organizationId}
            UNION
            SELECT category.id, category.parent_id
            FROM ${clauseCategories} category
            INNER JOIN ancestors
              ON category.id = ancestors.parent_id
            WHERE category.organization_id = ${organizationId}
          )
          SELECT EXISTS (
            SELECT 1 FROM ancestors WHERE id = ${categoryId}
          ) AS found
        `);
        if (result.at(0)?.found === true) {
          return Result.err(treeParentCycleError(CIRCULAR_CATEGORY_MESSAGE));
        }
      }

      const updates = {
        ...pickDefined(body, ["name", "description", "parentId", "sortOrder"]),
        updatedAt: new Date(),
      };

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
      addFieldDiff(changes, "name", existing.name, updates.name);
      addFieldDiff(
        changes,
        "description",
        existing.description,
        updates.description,
      );
      addFieldDiff(changes, "parentId", existing.parentId, updates.parentId);
      addFieldDiff(changes, "sortOrder", existing.sortOrder, updates.sortOrder);

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CLAUSE_CATEGORY,
        resourceId: categoryId,
        changes,
      });

      if (!row) {
        panic("Failed to update clause category");
      }
      return Result.ok(row);
    },
  );

  if (
    attempt.isErr() &&
    isTreeParentGuardError(attempt.error, "clauseCategories")
  ) {
    return Result.err(treeParentCycleError(CIRCULAR_CATEGORY_MESSAGE));
  }
  const outcome = yield* attempt;
  const updated = yield* outcome;
  return Result.ok(updated);
};

const addFieldDiff = (
  changes: FieldDiffs,
  key: string,
  oldValue: unknown,
  newValue: unknown,
): void => {
  if (newValue !== undefined && oldValue !== newValue) {
    changes[key] = { old: oldValue ?? null, new: newValue };
  }
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
  // Under the tree lock the parent read here is the one the children move to:
  // a concurrent reparent of this category either committed before (and is
  // read) or waits until the delete commits.
  const attempt = await safeDb(
    async (tx): Promise<Result<undefined, HandlerError>> => {
      await lockTree(tx, {
        tree: "clauseCategories",
        scopeId: organizationId,
      });

      const existing = await tx.query.clauseCategories.findFirst({
        where: {
          id: { eq: categoryId },
          organizationId: { eq: organizationId },
        },
        columns: { id: true, name: true, parentId: true },
      });
      if (!existing) {
        return Result.err(
          new HandlerError({ status: 404, message: "Category not found" }),
        );
      }

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
      return Result.ok(undefined);
    },
  );

  if (
    attempt.isErr() &&
    isTreeParentGuardError(attempt.error, "clauseCategories")
  ) {
    return Result.err(treeParentCycleError(CIRCULAR_CATEGORY_MESSAGE));
  }
  const outcome = yield* attempt;
  yield* outcome;
  return Result.ok({});
};
