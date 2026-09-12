import { panic } from "better-result";

import type { SearchSort } from "@/api/lib/legal-search/corpus-search-order";

/**
 * The decisions a corpus-index `newest` page may draw from: the ones that
 * carry a date at all.
 *
 * A decision the source never dated has no place in a date order, and the
 * projection gives it one anyway — the timestamp field is written on every
 * document, standing in for a missing date with `UNDATED_DECISION_TIMESTAMP`
 * (1800-01-01), because the engine requires its timestamp field. So the
 * sentinel band sorts somewhere, and without this clause it sorted at one end
 * of every date-ordered page.
 *
 * The decision's own `decision_date` is what separates them: the projection
 * omits it entirely when the source published none, so a bounded range over it
 * keeps exactly the dated decisions. Measured on the served generation, the
 * clause below drops 4,219 of 9,906,131 CZE passages, and the sentinel's own
 * documents are not among the 9,901,912 it keeps.
 *
 * The bounds are closed, and the floor is the sentinel's own date, for two
 * engine reasons:
 *
 *  - An open range matches every document, the absent field included: the doc
 *    mapping sets `index_field_presence: false`, so there is no existence
 *    query to ask instead. The floor may equal the sentinel date because the
 *    sentinel is written to the timestamp field, never to this one.
 *  - A floor the engine cannot parse fails silently rather than loudly: a
 *    1500-01-01 or 1000-01-01 floor matched zero documents of nine million.
 *    1800-01-01 is the oldest floor measured to behave, and it is below every
 *    decision any corpus holds.
 *
 * Nothing here is about sort direction. An earlier reading of this data blamed
 * a negative-epoch ordering bug and floored the band at 1970; the order was
 * simply ascending (see `corpus-search-order.ts`), and pre-1970 decisions rank
 * under `newest` like any other.
 */
const DATED_DECISION_FLOOR = "1800-01-01T00:00:00Z";

/** Far above any decision date, and closed for the reason the floor is. */
const DATED_DECISION_CEILING = "2100-01-01T00:00:00Z";

/**
 * The decision's own date, which the projection omits when the source
 * published none — unlike the timestamp field, which is always written.
 */
const DECISION_DATE_FIELD = "decision_date";

export const CASE_LAW_DATED_DECISION_CLAUSE = `${DECISION_DATE_FIELD}:[${DATED_DECISION_FLOOR} TO ${DATED_DECISION_CEILING}]`;

/**
 * A query narrowed to the decisions the request's order can rank. Applied to
 * the page, the total and every facet alike, so the counts a reader sees
 * describe the decisions the pages can reach.
 */
export const withCaseLawDatedDecisions = (
  query: string,
  sort: SearchSort,
): string => {
  switch (sort) {
    case "relevance":
      return query;
    case "newest":
      return `(${query}) AND ${CASE_LAW_DATED_DECISION_CLAUSE}`;
    default:
      sort satisfies never;
      return panic(`Unhandled search sort: ${String(sort)}`);
  }
};
