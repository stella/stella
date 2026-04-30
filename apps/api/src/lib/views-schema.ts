import { Type } from "@sinclair/typebox";
import { t } from "elysia";
import * as v from "valibot";

import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";

const v1 = v.literal(1);

const entityKindValues = [
  "document",
  "folder",
  "task",
  "message",
  "link",
] as const;

const builtinFieldValues = ["status", "priority"] as const;

const viewLayoutTypeValues = [
  "overview",
  "table",
  "filesystem",
  "kanban",
  "calendar",
  "timeline",
] as const;

const strictObjectOptions = { additionalProperties: false } as const;

export const viewFilterConditionSchema = v.union([
  v.strictObject({
    id: v.string(),
    field: v.literal("kind"),
    op: v.literal("in"),
    value: v.array(v.picklist(entityKindValues)),
  }),
  v.strictObject({
    id: v.string(),
    field: v.literal("property"),
    propertyId: v.pipe(v.string(), v.minLength(1)),
    op: v.picklist(["eq", "neq", "contains", "is_empty"]),
    value: v.optional(v.union([v.string(), v.array(v.string())])),
  }),
  v.strictObject({
    id: v.string(),
    field: v.literal("builtin"),
    builtinField: v.picklist(builtinFieldValues),
    op: v.picklist(["eq", "neq", "in", "is_empty"]),
    value: v.optional(v.union([v.string(), v.array(v.string())])),
  }),
]);

export type ViewFilterCondition = v.InferOutput<
  typeof viewFilterConditionSchema
>;

export const viewSortSchema = v.strictObject({
  propertyId: v.pipe(v.string(), v.minLength(1)),
  desc: v.boolean(),
});

export type ViewSort = v.InferOutput<typeof viewSortSchema>;

export const tViewFilterConditionSchema = t.Union([
  t.Object(
    {
      id: t.String(),
      field: t.Literal("kind"),
      op: t.Literal("in"),
      value: t.Array(
        t.Union([
          t.Literal("document"),
          t.Literal("folder"),
          t.Literal("task"),
          t.Literal("message"),
          t.Literal("link"),
        ]),
      ),
    },
    strictObjectOptions,
  ),
  t.Object(
    {
      id: t.String(),
      field: t.Literal("property"),
      propertyId: t.String({ minLength: 1 }),
      op: t.Union([
        t.Literal("eq"),
        t.Literal("neq"),
        t.Literal("contains"),
        t.Literal("is_empty"),
      ]),
      value: t.Optional(
        t.Union([t.String(), t.Array(t.String()), t.Undefined()]),
      ),
    },
    strictObjectOptions,
  ),
  t.Object(
    {
      id: t.String(),
      field: t.Literal("builtin"),
      builtinField: t.Union([t.Literal("status"), t.Literal("priority")]),
      op: t.Union([
        t.Literal("eq"),
        t.Literal("neq"),
        t.Literal("in"),
        t.Literal("is_empty"),
      ]),
      value: t.Optional(
        t.Union([t.String(), t.Array(t.String()), t.Undefined()]),
      ),
    },
    strictObjectOptions,
  ),
]);

export const tViewSortSchema = t.Object(
  {
    propertyId: t.String({ minLength: 1 }),
    desc: t.Boolean(),
  },
  strictObjectOptions,
);

const baseLayoutSchema = {
  filters: v.array(viewFilterConditionSchema),
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

export const parseViewLayout = (value: unknown): ViewLayout =>
  v.parse(viewLayoutSchema, value);

const tBaseLayoutSchema = {
  filters: t.Array(tViewFilterConditionSchema),
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

export const tCreateViewInputSchema = t.Object(
  {
    id: tSafeId("workspaceView"),
    name: tDefaultVarchar,
    layout: tViewLayoutSchema,
  },
  strictObjectOptions,
);

export const tUpdateViewBodySchema = t.Object(
  {
    name: t.Optional(tDefaultVarchar),
    layout: t.Optional(tViewLayoutSchema),
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
