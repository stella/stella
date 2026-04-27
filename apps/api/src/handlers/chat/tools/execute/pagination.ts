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

export const buildPaginatedOutputSchema = <TItemSchema extends v.GenericSchema>(
  itemSchema: TItemSchema,
) =>
  v.strictObject({
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

export type PaginationInput = {
  offset?: number | undefined;
  limit: number;
};

export type PaginatedOutput<TItem> = {
  hasMore: boolean;
  items: TItem[];
  nextOffset: number | null;
};

export const buildPaginatedResult = <TItem>({
  items,
  limit,
  offset,
}: {
  items: TItem[];
  limit: number;
  offset: number;
}): PaginatedOutput<TItem> => {
  const hasMore = items.length > limit;
  const pageItems = hasMore ? items.slice(0, limit) : items;

  return {
    hasMore,
    items: pageItems,
    nextOffset: hasMore ? offset + pageItems.length : null,
  };
};
