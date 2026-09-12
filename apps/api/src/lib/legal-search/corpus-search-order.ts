import { panic } from "better-result";

import {
  DEFAULT_SEARCH_SORT,
  SEARCH_SORTS,
  type SearchSort,
} from "@stll/api-contract/search";

/**
 * Re-exported so the search paths keep reading one module for the order, while
 * the vocabulary itself lives in the contract the saved query and the web
 * share.
 */
export { DEFAULT_SEARCH_SORT, SEARCH_SORTS, type SearchSort };

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
 * The engine's `sort_by` for an order. Descending in both branches: best first
 * for relevance, most recent first for newest.
 *
 * VERIFIED ON THE ENGINE, because the spelling is the opposite of what a
 * reader expects: a bare field name (and `+field`, identically) sorts
 * DESCENDING, and `-field` sorts ASCENDING. Over a band holding both pre-1970
 * and 2024 decisions, `decision_date_ts` and `+decision_date_ts` both answer
 * with 2024 first and `-decision_date_ts` with the pre-1970 one; over the
 * whole dated corpus the bare form leads with 2026. `_score` is the same
 * unprefixed form, which is why the scan has always received best-first hits
 * from it.
 *
 * A `-` here is therefore not a no-op, it is the reverse order: it shipped
 * once, and "newest" opened on 1994.
 */
export const corpusEngineSortBy = (order: CorpusSearchOrder): string => {
  switch (order.type) {
    case "relevance":
      return "_score";
    case "newest":
      return order.timestampField;
    default:
      order satisfies never;
      return panic(`Unhandled corpus search order: ${String(order)}`);
  }
};
