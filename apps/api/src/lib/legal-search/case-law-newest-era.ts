import { panic } from "better-result";

import type { SearchSort } from "@/api/lib/legal-search/corpus-search-order";

/**
 * The band of decision dates a corpus-index `newest` page may draw from, and
 * why it is a band rather than "has a date".
 *
 * Two engine facts force it, both measured against the served generation:
 *
 *  - The projection writes the timestamp field on every document, standing in
 *    for a missing date with `UNDATED_DECISION_TIMESTAMP` (1800-01-01). A
 *    decision the source never dated therefore sorts, it just sorts somewhere
 *    meaningless — and because the descending sort puts the 1800 band first,
 *    "newest" opened on a screen of undated rows.
 *  - The descending sort orders a negative epoch above every positive one, so
 *    a genuinely pre-1970 decision jumps to the top of "newest" the same way
 *    the sentinel does. Sorting on `decision_date` instead does not help: it
 *    misorders the same way, and a document without the field cannot carry a
 *    total order at all.
 *
 * So the floor is the epoch, not the sentinel: it is the oldest date the
 * engine can order correctly. Pre-1970 decisions are reachable under
 * `relevance`, under the date-range filter, and through browse — this bound
 * applies to the one order that cannot rank them.
 *
 * The bounds are closed because an open range matches every document,
 * including those the field is absent from: the doc mapping sets
 * `index_field_presence: false`, so there is no existence query to ask.
 *
 * REMOVAL CONDITION: a generation that leaves the date absent rather than
 * writing a sentinel, and an engine whose descending sort is signed, together
 * reduce this to "has a date". Neither is true of the served generation, and
 * changing the projection is an index rebuild.
 */
const NEWEST_ERA_FLOOR = "1970-01-01T00:00:00Z";

/** Far above any decision date, and finite for the same reason. */
const NEWEST_ERA_CEILING = "2100-01-01T00:00:00Z";

/**
 * The decision's own date, which the projection omits when the source
 * published none — unlike the timestamp field, which is always written.
 */
const DECISION_DATE_FIELD = "decision_date";

export const CASE_LAW_NEWEST_ERA_CLAUSE = `${DECISION_DATE_FIELD}:[${NEWEST_ERA_FLOOR} TO ${NEWEST_ERA_CEILING}]`;

/**
 * A query narrowed to what the request's order can actually rank. Applied to
 * the page, the total and every facet alike, so the counts a reader sees
 * describe the decisions the pages can reach.
 */
export const withCaseLawNewestEra = (
  query: string,
  sort: SearchSort,
): string => {
  switch (sort) {
    case "relevance":
      return query;
    case "newest":
      return `(${query}) AND ${CASE_LAW_NEWEST_ERA_CLAUSE}`;
    default:
      sort satisfies never;
      return panic(`Unhandled search sort: ${String(sort)}`);
  }
};
