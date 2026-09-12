import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { SearchSort } from "@/api/lib/legal-search/corpus-search-order";

/**
 * Where a decision with no published date sorts under `newest`: below every
 * date the column can hold, and finite, because the keyset cursor carries the
 * sort key as a number and refuses a non-finite one. `-infinity` would be the
 * natural floor and is exactly what cannot travel.
 *
 * The corpus-index branch cannot use this value — the engine requires its
 * timestamp field on every document, so undated decisions are banded at
 * `UNDATED_DECISION_TIMESTAMP` there instead. The two orders therefore agree
 * except about a decision dated before that band.
 */
export const UNDATED_DECISION_SORT_KEY = -1e15;

/**
 * The column the ORDER BY, the keyset predicate and the language-group
 * representative rule all read. One expression for the three, because keyset
 * pagination is only stable while they agree, and one per order, because the
 * order is what they have to agree about.
 *
 * `d` is the decisions table; both call sites bind it under that alias.
 */
export const decisionSortKeySql = (
  sort: SearchSort,
  relevanceScore: SQL,
): SQL => {
  switch (sort) {
    case "relevance":
      return relevanceScore;
    case "newest":
      return sql`coalesce(
        extract(epoch FROM d.decision_date),
        ${UNDATED_DECISION_SORT_KEY}::float8
      )`;
    default:
      sort satisfies never;
      return panic(`Unhandled search sort: ${String(sort)}`);
  }
};
