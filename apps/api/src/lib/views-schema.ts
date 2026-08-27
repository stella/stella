import { Type } from "@sinclair/typebox";
import { t } from "elysia";
import * as v from "valibot";

import {
  VIEW_FILTERS_MAX,
  VIEW_LAYOUT_TYPES,
  type ViewLayoutType as ContractViewLayoutType,
  VIEW_SORTS_MAX,
} from "@stll/api-contract";
import { CALCULATION_KINDS } from "@stll/calculations";
import { conditionHasFormula, conditionNodeSchema } from "@stll/conditions";

import {
  manualInputToolSchema,
  propertyContentSchema,
} from "@/api/db/schema-validators";
import { tConditionNode } from "@/api/lib/conditions/contract";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { logger } from "@/api/lib/observability/logger";
import { PROPERTY_DEPENDENCY_LIMITS } from "@/api/lib/properties/dependency-limits";

const v1 = v.literal(1);

const strictObjectOptions = { additionalProperties: false } as const;

export const viewSortSchema = v.strictObject({
  propertyId: v.pipe(v.string(), v.minLength(1)),
  desc: v.boolean(),
});

export type ViewSort = v.InferOutput<typeof viewSortSchema>;

export const tViewSortSchema = t.Object(
  {
    propertyId: t.String({ minLength: 1 }),
    desc: t.Boolean(),
  },
  strictObjectOptions,
);

/**
 * A calculation a view shows for one property: the board renders it in every
 * column header, the table under the property's column. Optional, so a view
 * that has never chosen one stores nothing.
 */
export const viewCalculationSchema = v.strictObject({
  propertyId: v.pipe(v.string(), v.minLength(1)),
  kind: v.picklist(CALCULATION_KINDS),
});

export type ViewCalculation = v.InferOutput<typeof viewCalculationSchema>;

export const tViewCalculationSchema = t.Object(
  {
    propertyId: t.String({ minLength: 1 }),
    kind: t.UnionEnum([...CALCULATION_KINDS]),
  },
  strictObjectOptions,
);

const baseLayoutSchema = {
  // Bounded here as well as at the request boundary: a stored layout is
  // re-parsed on every read, and parseViewLayoutSafe recovers from an
  // oversized list by keeping the leading filters rather than failing the view.
  filters: v.pipe(v.array(conditionNodeSchema), v.maxLength(VIEW_FILTERS_MAX)),
  // Hard ceiling for incoming layouts. Stored rows go through
  // parseStoredViewLayout, which trims an oversized list before this check
  // so a layout written before the cap existed still reads.
  sorts: v.pipe(v.array(viewSortSchema), v.maxLength(VIEW_SORTS_MAX)),
  hiddenProperties: v.array(v.string()),
  // Defaulted at the parse boundary rather than at every read: a view with no
  // calculations has an empty list, not an absent one, so nothing downstream
  // has to decide what a missing field means.
  calculations: v.optional(v.array(viewCalculationSchema), []),
};

export type ViewLayoutBase = v.InferOutput<
  v.ObjectSchema<typeof baseLayoutSchema, "">
>;

const versionedBaseLayoutSchema = {
  version: v1,
  ...baseLayoutSchema,
};

const overviewLayoutSchema = v.strictObject({
  type: v.literal("overview"),
  ...versionedBaseLayoutSchema,
});

const tableLayoutSchema = v.strictObject({
  type: v.literal("table"),
  columnOrder: v.array(v.string()),
  columnPinning: v.array(v.string()),
  ...versionedBaseLayoutSchema,
  groupByPropertyId: v.optional(v.pipe(v.string(), v.minLength(1))),
});

const filesystemLayoutSchema = v.strictObject({
  type: v.literal("filesystem"),
  ...versionedBaseLayoutSchema,
});

const kanbanLayoutSchema = v.strictObject({
  type: v.literal("kanban"),
  ...versionedBaseLayoutSchema,
  groupByPropertyId: v.optional(v.pipe(v.string(), v.minLength(1))),
  subgroupByPropertyId: v.optional(v.pipe(v.string(), v.minLength(1))),
});

const calendarLayoutSchema = v.strictObject({
  type: v.literal("calendar"),
  ...versionedBaseLayoutSchema,
  datePropertyId: v.pipe(v.string(), v.minLength(1)),
  endDatePropertyId: v.optional(v.pipe(v.string(), v.minLength(1))),
  additionalDatePropertyIds: v.optional(
    v.array(v.pipe(v.string(), v.minLength(1))),
  ),
  mode: v.picklist(["month", "week", "year"]),
});

const timelineLayoutSchema = v.strictObject({
  type: v.literal("timeline"),
  ...versionedBaseLayoutSchema,
  startDatePropertyId: v.pipe(v.string(), v.minLength(1)),
  endDatePropertyId: v.pipe(v.string(), v.minLength(1)),
  zoom: v.picklist(["day", "week", "month", "quarter"]),
  groupByPropertyId: v.optional(v.pipe(v.string(), v.minLength(1))),
  showTable: v.boolean(),
});

const layoutSchemas = [
  overviewLayoutSchema,
  tableLayoutSchema,
  filesystemLayoutSchema,
  kanbanLayoutSchema,
  calendarLayoutSchema,
  timelineLayoutSchema,
] as const;

export const viewLayoutSchema = v.variant("type", layoutSchemas);

export type ViewLayout = v.InferOutput<typeof viewLayoutSchema>;
type SchemaViewLayoutType = ViewLayout["type"];

true satisfies Exclude<
  ContractViewLayoutType,
  SchemaViewLayoutType
> extends never
  ? true
  : never;
true satisfies Exclude<
  SchemaViewLayoutType,
  ContractViewLayoutType
> extends never
  ? true
  : never;

export type ViewLayoutType = ContractViewLayoutType;

const hasFiltersField = (value: unknown): value is { filters: unknown } =>
  typeof value === "object" && value !== null && "filters" in value;

/**
 * Stored filters are validated leniently: any node that does not parse as the
 * canonical condition AST is dropped, so a stray pre-AST row resets to an empty
 * filter instead of failing the whole layout read. New writes are AST nodes and
 * pass through untouched. A `formula` operand is valid in the type system (it
 * exists for template rules) but has no SQL transpilation, so a filter that
 * carries one is dropped rather than silently mismatched.
 */
const withValidFilters = (value: unknown): unknown => {
  if (!hasFiltersField(value)) {
    return value;
  }
  const filters = Array.isArray(value.filters)
    ? value.filters.filter(
        (node) => v.is(conditionNodeSchema, node) && !conditionHasFormula(node),
      )
    : [];
  return { ...value, filters };
};

const hasSortsField = (value: unknown): value is { sorts: unknown } =>
  typeof value === "object" && value !== null && "sorts" in value;

/**
 * Stored layouts written before the sort cap existed can carry more sorts
 * than `VIEW_SORTS_MAX`. Keep the leading sorts (the order the user chose)
 * and report the trim once per layout read, so the residue stays visible
 * until the migration that rewrites those rows has run everywhere.
 */
/** Same normalisation for a persisted filter list over `VIEW_FILTERS_MAX`. */
const withBoundedFilters = (value: unknown): unknown => {
  if (!hasFiltersField(value) || !Array.isArray(value.filters)) {
    return value;
  }
  if (value.filters.length <= VIEW_FILTERS_MAX) {
    return value;
  }
  logger.warn("views.layout.filters_truncated", {
    filter_count: value.filters.length,
    filter_limit: VIEW_FILTERS_MAX,
  });
  return { ...value, filters: value.filters.slice(0, VIEW_FILTERS_MAX) };
};

const withBoundedSorts = (value: unknown): unknown => {
  if (!hasSortsField(value) || !Array.isArray(value.sorts)) {
    return value;
  }
  if (value.sorts.length <= VIEW_SORTS_MAX) {
    return value;
  }
  logger.warn("views.layout.sorts_truncated", {
    sort_count: value.sorts.length,
    sort_limit: VIEW_SORTS_MAX,
  });
  return { ...value, sorts: value.sorts.slice(0, VIEW_SORTS_MAX) };
};

/**
 * Strict parse for a layout arriving in a request body: an oversized sort
 * list is a client error, never silently shortened.
 */
export const parseViewLayout = (value: unknown): ViewLayout =>
  v.parse(viewLayoutSchema, withValidFilters(value));

/**
 * Parse a layout read back from the database. Same schema as
 * `parseViewLayout`, but a persisted sort list over the cap is normalised
 * rather than rejected: a row that was valid when written must stay readable.
 */
export const parseStoredViewLayout = (value: unknown): ViewLayout =>
  v.parse(
    viewLayoutSchema,
    withBoundedSorts(withBoundedFilters(withValidFilters(value))),
  );

// Recovers a stored layout that fails strict parsing: older views can carry a
// filter grammar the current schema rejects. Drop the unparseable filters/sorts
// and retry so a single legacy view can't fail the whole views response; fall
// back to a minimal filesystem layout only if the row is otherwise unrecoverable.
export const parseViewLayoutSafe = (value: unknown): ViewLayout => {
  const direct = v.safeParse(
    viewLayoutSchema,
    withBoundedSorts(withBoundedFilters(withValidFilters(value))),
  );
  if (direct.success) {
    return direct.output;
  }

  if (typeof value === "object" && value !== null) {
    const sanitized = v.safeParse(viewLayoutSchema, {
      ...value,
      filters: [],
      sorts: [],
    });
    if (sanitized.success) {
      return sanitized.output;
    }
  }

  return {
    type: "filesystem",
    version: 1,
    filters: [],
    sorts: [],
    hiddenProperties: [],
    calculations: [],
  };
};

const tBaseLayoutSchema = {
  filters: t.Array(tConditionNode, { maxItems: VIEW_FILTERS_MAX }),
  sorts: t.Array(tViewSortSchema, { maxItems: VIEW_SORTS_MAX }),
  hiddenProperties: t.Array(t.String()),
  calculations: t.Optional(t.Array(tViewCalculationSchema)),
};

const tVersionedBaseLayoutSchema = {
  version: t.Literal(1),
  ...tBaseLayoutSchema,
};

const tViewLayoutDefinition = t.Union([
  t.Object(
    {
      type: t.Literal("overview"),
      ...tVersionedBaseLayoutSchema,
    },
    strictObjectOptions,
  ),
  t.Object(
    {
      type: t.Literal("table"),
      columnOrder: t.Array(t.String()),
      columnPinning: t.Array(t.String()),
      ...tVersionedBaseLayoutSchema,
      groupByPropertyId: t.Optional(t.String({ minLength: 1 })),
    },
    strictObjectOptions,
  ),
  t.Object(
    {
      type: t.Literal("filesystem"),
      ...tVersionedBaseLayoutSchema,
    },
    strictObjectOptions,
  ),
  t.Object(
    {
      type: t.Literal("kanban"),
      ...tVersionedBaseLayoutSchema,
      groupByPropertyId: t.Optional(t.String({ minLength: 1 })),
      subgroupByPropertyId: t.Optional(t.String({ minLength: 1 })),
    },
    strictObjectOptions,
  ),
  t.Object(
    {
      type: t.Literal("calendar"),
      ...tVersionedBaseLayoutSchema,
      datePropertyId: t.String({ minLength: 1 }),
      endDatePropertyId: t.Optional(t.String({ minLength: 1 })),
      additionalDatePropertyIds: t.Optional(
        t.Array(t.String({ minLength: 1 })),
      ),
      mode: t.Union([t.Literal("month"), t.Literal("week"), t.Literal("year")]),
    },
    strictObjectOptions,
  ),
  t.Object(
    {
      type: t.Literal("timeline"),
      ...tVersionedBaseLayoutSchema,
      startDatePropertyId: t.String({ minLength: 1 }),
      endDatePropertyId: t.String({ minLength: 1 }),
      zoom: t.Union([
        t.Literal("day"),
        t.Literal("week"),
        t.Literal("month"),
        t.Literal("quarter"),
      ]),
      groupByPropertyId: t.Optional(t.String({ minLength: 1 })),
      showTable: t.Boolean(),
    },
    strictObjectOptions,
  ),
]);

export const tViewLayoutSchema = Type.Unsafe<ViewLayout>({
  ...tViewLayoutDefinition,
});

const tViewTemplatePropertyToolSchema = t.Union([
  t.Object({
    version: t.Literal(1),
    type: t.Literal("ai-model"),
    prompt: t.String({ maxLength: 1000 }),
  }),
  manualInputToolSchema,
]);

export const tViewTemplatePropertySchema = t.Object(
  {
    version: t.Literal(1),
    sourceId: t.String({ minLength: 1 }),
    name: tDefaultVarchar,
    content: propertyContentSchema,
    tool: tViewTemplatePropertyToolSchema,
    role: t.Optional(
      t.Union([t.Literal("document-type-classifier"), t.Null()]),
    ),
    createIfMissing: t.Boolean(),
    dependencies: t.Optional(
      t.Array(
        t.Object(
          {
            dependsOnSourceId: t.String({ minLength: 1 }),
            condition: t.Union([tConditionNode, t.Null()]),
          },
          strictObjectOptions,
        ),
        { maxItems: PROPERTY_DEPENDENCY_LIMITS.perProperty },
      ),
    ),
  },
  strictObjectOptions,
);

export type ViewTemplateProperty = typeof tViewTemplatePropertySchema.static;

export const tCreateViewInputSchema = t.Object(
  {
    id: tSafeId("workspaceView"),
    name: tDefaultVarchar,
    layout: tViewLayoutSchema,
    templateProperties: t.Optional(t.Array(tViewTemplatePropertySchema)),
  },
  strictObjectOptions,
);

export const tUpdateViewBodySchema = t.Object(
  {
    name: t.Optional(tDefaultVarchar),
    layout: t.Optional(tViewLayoutSchema),
    templateProperties: t.Optional(t.Array(tViewTemplatePropertySchema)),
  },
  strictObjectOptions,
);

export const updateViewInputSchema = v.strictObject({
  viewId: v.string(),
  name: v.optional(v.string()),
  layout: v.optional(viewLayoutSchema),
});

export type UpdateViewInput = v.InferInput<typeof updateViewInputSchema>;

const viewLayoutTypeSchema = v.picklist(VIEW_LAYOUT_TYPES);

export const convertViewInputSchema = v.strictObject({
  viewId: v.string(),
  targetType: viewLayoutTypeSchema,
});

export type ConvertViewInput = v.InferInput<typeof convertViewInputSchema>;

export const reorderViewsInputSchema = v.strictObject({
  viewIds: v.array(v.string()),
});

export type ReorderViewsInput = v.InferInput<typeof reorderViewsInputSchema>;
