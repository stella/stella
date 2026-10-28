import * as v from "valibot";

import {
  VIEW_FILTERS_MAX,
  VIEW_SORTS_MAX,
  type ViewLayoutType as ContractViewLayoutType,
} from "@stll/api-contract";
import { CALCULATION_KINDS } from "@stll/calculations";
import { conditionHasFormula, conditionNodeSchema } from "@stll/conditions";

import {
  manualInputToolSchema,
  propertyContentSchema,
} from "@/api/db/schema-validators";
import { tConditionNode } from "@/api/lib/conditions/contract";
import {
  defaultVarcharSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import { logger } from "@/api/lib/observability/logger";
import { PROPERTY_DEPENDENCY_LIMITS } from "@/api/lib/properties/dependency-limits";
import { brandPersistedLegalListId } from "@/api/lib/safe-id-boundaries";

const v1 = v.literal(1);

const viewSortSchema = v.strictObject({
  propertyId: v.pipe(v.string(), v.minLength(1)),
  desc: v.boolean(),
});

export type ViewSort = v.InferOutput<typeof viewSortSchema>;

export const tViewSortSchema = v.strictObject({
  propertyId: v.pipe(v.string(), v.minLength(1)),
  desc: v.boolean(),
});

/**
 * A calculation a view shows for one property: the board renders it in every
 * column header, the table under the property's column. Optional, so a view
 * that has never chosen one stores nothing.
 */
const viewCalculationSchema = v.strictObject({
  propertyId: v.pipe(v.string(), v.minLength(1)),
  kind: v.picklist(CALCULATION_KINDS),
});

const tViewCalculationSchema = v.strictObject({
  propertyId: v.pipe(v.string(), v.minLength(1)),
  kind: v.picklist([...CALCULATION_KINDS]),
});

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

/** Verification of the matter's documents against one legal list's facts.
 *  `listId` is null until a list is picked. */
const avtLayoutSchema = v.strictObject({
  type: v.literal("avt"),
  ...versionedBaseLayoutSchema,
  listId: v.nullable(
    v.pipe(v.string(), v.uuid(), v.transform(brandPersistedLegalListId)),
  ),
});

/** The matter's inbound mail: its address and the messages filed to it. */
const correspondenceLayoutSchema = v.strictObject({
  type: v.literal("correspondence"),
  ...versionedBaseLayoutSchema,
});

const layoutSchemas = [
  overviewLayoutSchema,
  tableLayoutSchema,
  filesystemLayoutSchema,
  kanbanLayoutSchema,
  calendarLayoutSchema,
  timelineLayoutSchema,
  avtLayoutSchema,
  correspondenceLayoutSchema,
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
  filters: v.pipe(v.array(tConditionNode), v.maxLength(VIEW_FILTERS_MAX)),
  sorts: v.pipe(v.array(tViewSortSchema), v.maxLength(VIEW_SORTS_MAX)),
  hiddenProperties: v.array(v.string()),
  calculations: v.optional(v.array(tViewCalculationSchema)),
};

const tVersionedBaseLayoutSchema = {
  version: v.literal(1),
  ...tBaseLayoutSchema,
};

/**
 * A layout as a request carries it. Handlers read it through
 * `parseViewLayout`, which applies the stored schema's defaults and brands,
 * so the route contract states what a client sends rather than `ViewLayout`.
 */
export const tViewLayoutSchema = v.union([
  v.strictObject({
    type: v.literal("overview"),
    ...tVersionedBaseLayoutSchema,
  }),
  v.strictObject({
    type: v.literal("table"),
    columnOrder: v.array(v.string()),
    columnPinning: v.array(v.string()),
    ...tVersionedBaseLayoutSchema,
    groupByPropertyId: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.strictObject({
    type: v.literal("filesystem"),
    ...tVersionedBaseLayoutSchema,
  }),
  v.strictObject({
    type: v.literal("kanban"),
    ...tVersionedBaseLayoutSchema,
    groupByPropertyId: v.optional(v.pipe(v.string(), v.minLength(1))),
    subgroupByPropertyId: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.strictObject({
    type: v.literal("calendar"),
    ...tVersionedBaseLayoutSchema,
    datePropertyId: v.pipe(v.string(), v.minLength(1)),
    endDatePropertyId: v.optional(v.pipe(v.string(), v.minLength(1))),
    additionalDatePropertyIds: v.optional(
      v.array(v.pipe(v.string(), v.minLength(1))),
    ),
    mode: v.picklist(["month", "week", "year"]),
  }),
  v.strictObject({
    type: v.literal("timeline"),
    ...tVersionedBaseLayoutSchema,
    startDatePropertyId: v.pipe(v.string(), v.minLength(1)),
    endDatePropertyId: v.pipe(v.string(), v.minLength(1)),
    zoom: v.picklist(["day", "week", "month", "quarter"]),
    groupByPropertyId: v.optional(v.pipe(v.string(), v.minLength(1))),
    showTable: v.boolean(),
  }),
  v.strictObject({
    type: v.literal("avt"),
    ...tVersionedBaseLayoutSchema,
    listId: v.union([resourceIdSchema("legalList"), v.null()]),
  }),
  v.strictObject({
    type: v.literal("correspondence"),
    ...tVersionedBaseLayoutSchema,
  }),
]);

const tViewTemplatePropertyToolSchema = v.union([
  v.object({
    version: v.literal(1),
    type: v.literal("ai-model"),
    prompt: v.pipe(v.string(), v.maxLength(1000)),
  }),
  manualInputToolSchema,
]);

export const tViewTemplatePropertySchema = v.strictObject({
  version: v.literal(1),
  sourceId: v.pipe(v.string(), v.minLength(1)),
  name: defaultVarcharSchema,
  content: propertyContentSchema,
  tool: tViewTemplatePropertyToolSchema,
  role: v.optional(v.union([v.literal("document-type-classifier"), v.null()])),
  createIfMissing: v.boolean(),
  dependencies: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          dependsOnSourceId: v.pipe(v.string(), v.minLength(1)),
          condition: v.union([tConditionNode, v.null()]),
        }),
      ),
      v.maxLength(PROPERTY_DEPENDENCY_LIMITS.perProperty),
    ),
  ),
});

export type ViewTemplateProperty = v.InferOutput<
  typeof tViewTemplatePropertySchema
>;

export const tCreateViewInputSchema = v.strictObject({
  id: resourceIdSchema("workspaceView"),
  name: defaultVarcharSchema,
  layout: tViewLayoutSchema,
  templateProperties: v.optional(v.array(tViewTemplatePropertySchema)),
});

export const tUpdateViewBodySchema = v.strictObject({
  name: v.optional(defaultVarcharSchema),
  layout: v.optional(tViewLayoutSchema),
  templateProperties: v.optional(v.array(tViewTemplatePropertySchema)),
});
