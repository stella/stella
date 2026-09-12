import { panic } from "better-result";

/**
 * The orders a search may be read in: one list, read by the request schema,
 * the handler, the scan and the cursor codec.
 *
 * A page boundary only means something inside the order that produced it — a
 * boundary in a relevance ranking bounds nothing in a date ranking — so the
 * order travels in the cursor and a cursor from one order is refused by the
 * other, exactly as a cursor from another expansion dictionary is.
 *
 * `relevance` is first because Elysia coerces an absent optional `UnionEnum`
 * to its first member, so slot 0 has to be the default the handler applies.
 */
export const SEARCH_SORTS = ["relevance", "newest"] as const;

export type SearchSort = (typeof SEARCH_SORTS)[number];

export const DEFAULT_SEARCH_SORT = SEARCH_SORTS[0];

/**
 * An order together with what the engine needs to express it. The newest
 * branch carries the corpus's timestamp field rather than naming one here:
 * which field holds a document's date is a property of the generation being
 * read, and the legislation corpus does not map the case-law one.
 */
export type CorpusSearchOrder =
  | { type: "relevance" }
  | { type: "newest"; timestampField: string };

export const RELEVANCE_ORDER = {
  type: "relevance",
} as const satisfies CorpusSearchOrder;

/**
 * The engine's `sort_by` for an order. Descending in both branches: best
 * first for relevance, most recent first for newest.
 */
export const corpusEngineSortBy = (order: CorpusSearchOrder): string => {
  switch (order.type) {
    case "relevance":
      return "_score";
    case "newest":
      return `-${order.timestampField}`;
    default:
      order satisfies never;
      return panic(`Unhandled corpus search order: ${String(order)}`);
  }
};
