import * as v from "valibot";

const entityKindValues = ["document", "folder", "task", "message"] as const;

const builtinFieldValues = ["status", "priority"] as const;

export const viewFilterConditionSchema = v.union([
  v.object({
    id: v.string(),
    field: v.literal("kind"),
    op: v.literal("in"),
    value: v.array(v.picklist(entityKindValues)),
  }),
  v.object({
    id: v.string(),
    field: v.literal("property"),
    propertyId: v.pipe(v.string(), v.minLength(1)),
    op: v.picklist(["eq", "neq", "contains", "is_empty"]),
    value: v.optional(v.union([v.string(), v.array(v.string())])),
  }),
  v.object({
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

export const viewSortSchema = v.object({
  propertyId: v.pipe(v.string(), v.minLength(1)),
  desc: v.boolean(),
});

const baseLayoutSchema = {
  filters: v.array(viewFilterConditionSchema),
  sorts: v.array(viewSortSchema),
  hiddenProperties: v.array(v.string()),
};

export type ViewLayoutBase = v.InferOutput<
  v.ObjectSchema<typeof baseLayoutSchema, "">
>;

const overviewLayoutSchema = v.object({
  type: v.literal("overview"),
  ...baseLayoutSchema,
});

const tableLayoutSchema = v.object({
  type: v.literal("table"),
  columnOrder: v.array(v.string()),
  columnPinning: v.array(v.string()),
  ...baseLayoutSchema,
});

const filesystemLayoutSchema = v.object({
  type: v.literal("filesystem"),
  ...baseLayoutSchema,
});

const kanbanLayoutSchema = v.object({
  type: v.literal("kanban"),
  ...baseLayoutSchema,
  groupByPropertyId: v.optional(v.pipe(v.string(), v.minLength(1))),
});

const calendarLayoutSchema = v.object({
  type: v.literal("calendar"),
  ...baseLayoutSchema,
  datePropertyId: v.pipe(v.string(), v.minLength(1)),
  endDatePropertyId: v.optional(v.pipe(v.string(), v.minLength(1))),
  additionalDatePropertyIds: v.optional(
    v.array(v.pipe(v.string(), v.minLength(1))),
  ),
  mode: v.picklist(["month", "week", "year"]),
});

const timelineLayoutSchema = v.object({
  type: v.literal("timeline"),
  ...baseLayoutSchema,
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

export const createViewInputSchema = v.object({
  id: v.string(),
  name: v.string(),
  layout: viewLayoutSchema,
});

export type CreateViewInput = v.InferInput<typeof createViewInputSchema>;

export const updateViewInputSchema = v.object({
  viewId: v.string(),
  name: v.optional(v.string()),
  layout: v.optional(viewLayoutSchema),
});

export type UpdateViewInput = v.InferInput<typeof updateViewInputSchema>;

export const viewLayoutTypeSchema = v.picklist([
  "overview",
  "table",
  "filesystem",
  "kanban",
  "calendar",
  "timeline",
]);

export const convertViewInputSchema = v.object({
  viewId: v.string(),
  targetType: viewLayoutTypeSchema,
});

export type ConvertViewInput = v.InferInput<typeof convertViewInputSchema>;

export const reorderViewsInputSchema = v.object({
  viewIds: v.array(v.string()),
});

export type ReorderViewsInput = v.InferInput<typeof reorderViewsInputSchema>;
