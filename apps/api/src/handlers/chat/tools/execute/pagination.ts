import * as v from "valibot";

import { LIMITS } from "@/api/lib/limits";

export const paginationInputEntries = {
  offset: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(0),
      v.description("Pagination offset for the current page."),
    ),
  ),
  limit: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(LIMITS.chatExecutePageSizeMax),
      v.description(
        "Page size. Optional; defaults server-side and caps at 500.",
      ),
    ),
    LIMITS.chatExecutePageSizeDefault,
  ),
} as const;

/**
 * Descriptor pairing a readonly read schema with its shape literal.
 * The two builders below are the only source of these descriptors so
 * `outputShape` and the schema cannot drift; consumers receive them
 * already linked instead of sniffing the schema at runtime.
 */
export type StellaAIOutputDescriptor<
  TSchema extends v.GenericSchema<unknown, StellaAIOutput<unknown>>,
  TShape extends StellaAIOutputShape,
> = {
  outputShape: TShape;
  schema: TSchema;
};

export type StellaAIOutputShape =
  | "{ items }"
  | "{ items, hasMore, nextOffset }";

export const buildPaginatedOutputSchema = <TItemSchema extends v.GenericSchema>(
  itemSchema: TItemSchema,
) => {
  const schema = v.strictObject({
    hasMore: v.pipe(
      v.boolean(),
      v.description("Whether another page is available."),
    ),
    items: v.array(itemSchema),
    nextOffset: v.nullable(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(0),
        v.description("Pagination offset to resume from."),
      ),
    ),
  });

  return {
    outputShape: "{ items, hasMore, nextOffset }",
    schema,
  } as const satisfies StellaAIOutputDescriptor<
    typeof schema,
    "{ items, hasMore, nextOffset }"
  >;
};

export const buildItemsOutputSchema = <TItemSchema extends v.GenericSchema>(
  itemSchema: TItemSchema,
) => {
  const schema = v.strictObject({
    items: v.pipe(
      v.array(itemSchema),
      v.description(
        "Returned records. All stella AI data-read functions put records here.",
      ),
    ),
  });

  return {
    outputShape: "{ items }",
    schema,
  } as const satisfies StellaAIOutputDescriptor<typeof schema, "{ items }">;
};

export type PaginationInput = {
  offset?: number | undefined;
  limit: number;
};

export type StellaAIItemsOutput<TItem> = {
  items: TItem[];
};

export type StellaAIPaginatedOutput<TItem> = {
  hasMore: boolean;
  items: TItem[];
  nextOffset: number | null;
};

export type StellaAIOutput<TItem> =
  | StellaAIItemsOutput<TItem>
  | StellaAIPaginatedOutput<TItem>;

export const buildPaginatedResult = <TItem>({
  items,
  limit,
  offset,
}: {
  items: TItem[];
  limit: number;
  offset: number;
}): StellaAIPaginatedOutput<TItem> => {
  const hasMore = items.length > limit;
  const pageItems = hasMore ? items.slice(0, limit) : items;

  return {
    hasMore,
    items: pageItems,
    nextOffset: hasMore ? offset + pageItems.length : null,
  };
};
