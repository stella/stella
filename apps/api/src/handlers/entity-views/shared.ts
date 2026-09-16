import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  ENTITY_VIEW_COLUMNS,
  ENTITY_VIEW_GROUP,
} from "@stll/api-contract/entity-views";
import type { ConditionNode, Operand } from "@stll/conditions";

import { entityViews } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { parseViewLayout, tViewLayoutSchema } from "@/api/lib/views-schema";
import {
  hasDuplicateSorts,
  hasMultipleKindFilters,
} from "@/api/lib/views/utils";

export const entityViewParams = t.Object({ viewId: tSafeId("workspaceView") });
const viewName = t.String({ minLength: 1, maxLength: 256, pattern: "\\S" });
export const entityViewBody = t.Object({
  name: viewName,
  layout: tViewLayoutSchema,
});
export const entityViewUpdateBody = t.Object({
  name: t.Optional(viewName),
  layout: t.Optional(tViewLayoutSchema),
});
export const entityViewReorderBody = t.Object({
  viewIds: t.Array(tSafeId("workspaceView"), {
    minItems: 1,
    maxItems: LIMITS.viewsCount,
  }),
});
export const response = (row: typeof entityViews.$inferSelect) => ({
  version: 1 as const,
  id: row.id,
  name: row.name,
  layout: row.layout,
  position: row.position,
  createdAt: row.createdAt.toISOString(),
});

export const viewOwner = ({
  organizationId,
  userId,
}: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
}) =>
  and(
    eq(entityViews.organizationId, organizationId),
    eq(entityViews.userId, userId),
  );

const supportedOperand = (operand: Operand) =>
  operand.type === "kind" ||
  operand.type === "builtin" ||
  operand.type === "literal";
const supportedFilter = (node: ConditionNode): boolean => {
  switch (node.type) {
    case "group":
      return node.children.every(supportedFilter);
    case "compare":
      return supportedOperand(node.left) && supportedOperand(node.right);
    case "predicate":
      return supportedOperand(node.operand);
  }
};

export const validateEntityViewLayout = (value: unknown) => {
  const parsed = Result.try({
    try: () => parseViewLayout(value),
    catch: () =>
      new HandlerError({ status: 400, message: "Invalid view layout" }),
  });
  if (parsed.isErr()) return parsed;
  const layout = parsed.value;
  if (layout.type !== "table" && layout.type !== "kanban")
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Cross-matter views support table and kanban layouts",
      }),
    );
  const groups: readonly string[] = Object.values(ENTITY_VIEW_GROUP);
  const allowedPrimary =
    layout.type === "table"
      ? groups
      : [ENTITY_VIEW_GROUP.STATUS, ENTITY_VIEW_GROUP.KIND];
  if (
    (layout.groupByPropertyId !== undefined &&
      !allowedPrimary.includes(layout.groupByPropertyId)) ||
    (layout.type === "kanban" &&
      layout.subgroupByPropertyId !== undefined &&
      (!groups.includes(layout.subgroupByPropertyId) ||
        layout.subgroupByPropertyId === layout.groupByPropertyId))
  ) {
    return Result.err(
      new HandlerError({ status: 400, message: "Unsupported view grouping" }),
    );
  }
  if (
    !layout.filters.every(supportedFilter) ||
    hasDuplicateSorts(layout.sorts) ||
    hasMultipleKindFilters(layout.filters)
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Unsupported or duplicate view filters or sorts",
      }),
    );
  }
  const columns = Object.keys(ENTITY_VIEW_COLUMNS);
  const sortColumns = Object.entries(ENTITY_VIEW_COLUMNS)
    .filter(([, column]) => column.sortable)
    .map(([id]) => id);
  if (
    layout.calculations.length > 0 ||
    layout.sorts.some((sort) => !sortColumns.includes(sort.propertyId)) ||
    layout.hiddenProperties.some(
      (id) => layout.type !== "table" || !columns.includes(id),
    ) ||
    (layout.type === "table" &&
      [...layout.columnOrder, ...layout.columnPinning].some(
        (id) => !columns.includes(id),
      ))
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Unsupported view columns, sorts or calculations",
      }),
    );
  }
  return Result.ok(layout);
};
