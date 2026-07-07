import { Type } from "@sinclair/typebox";
import { t } from "elysia";
import * as v from "valibot";

import { conditionHasFormula, conditionNodeSchema } from "@stll/conditions";

import {
  manualInputToolSchema,
  propertyContentSchema,
} from "@/api/db/schema-validators";
import { tConditionNode } from "@/api/lib/conditions/contract";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";

const v1 = v.literal(1);

const viewLayoutTypeValues = [
  "overview",
  "table",
  "filesystem",
  "kanban",
  "calendar",
  "timeline",
] as const;

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

const baseLayoutSchema = {
  filters: v.array(conditionNodeSchema),
  sorts: v.array(viewSortSchema),
  hiddenProperties: v.array(v.string()),
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
export type ViewLayoutType = ViewLayout["type"];

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

export const parseViewLayout = (value: unknown): ViewLayout =>
  v.parse(viewLayoutSchema, withValidFilters(value));

// Recovers a stored layout that fails strict parsing: older views can carry a
// filter grammar the current schema rejects. Drop the unparseable filters/sorts
// and retry so a single legacy view can't fail the whole views response; fall
// back to a minimal filesystem layout only if the row is otherwise unrecoverable.
export const parseViewLayoutSafe = (value: unknown): ViewLayout => {
  const direct = v.safeParse(viewLayoutSchema, withValidFilters(value));
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
  };
};

const tBaseLayoutSchema = {
  filters: t.Array(tConditionNode),
  sorts: t.Array(tViewSortSchema),
  hiddenProperties: t.Array(t.String()),
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
    role: t.Optional(t.UnionEnum(["document-type-classifier"])),
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

const viewLayoutTypeSchema = v.picklist(viewLayoutTypeValues);

export const convertViewInputSchema = v.strictObject({
  viewId: v.string(),
  targetType: viewLayoutTypeSchema,
});

export type ConvertViewInput = v.InferInput<typeof convertViewInputSchema>;

export const reorderViewsInputSchema = v.strictObject({
  viewIds: v.array(v.string()),
});

export type ReorderViewsInput = v.InferInput<typeof reorderViewsInputSchema>;
