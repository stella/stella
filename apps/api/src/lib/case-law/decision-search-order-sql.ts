import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { SearchSort } from "@/api/lib/legal-search/corpus-search-order";

/**
 * Restricts `newest` to the decisions that order has a place for. A decision
 * the source never dated cannot be ranked by date at all, so it is left out
 * of the page, the total and every facet alike rather than piled at one end.
 *
 * The corpus-index branch draws the same line one step tighter — its
 * descending sort misorders a negative epoch, so it floors at 1970 (see
 * `case-law-newest-era.ts`). Postgres orders every date correctly, so this
 * side keeps the decisions that one cannot rank.
 */
export const decisionDatedFilterSql = (sort: SearchSort): SQL => {
  switch (sort) {
    case "relevance":
      return sql``;
    case "newest":
      return sql`AND d.decision_date IS NOT NULL`;
    default:
      sort satisfies never;
      return panic(`Unhandled search sort: ${String(sort)}`);
  }
};

/**
 * The column the ORDER BY, the keyset predicate and the language-group
 * representative rule all read. One expression for the three, because keyset
 * pagination is only stable while they agree, and one per order, because the
 * order is what they have to agree about.
 *
 * `d` is the decisions table; every call site binds it under that alias.
 */
export const decisionSortKeySql = (
  sort: SearchSort,
  relevanceScore: SQL,
): SQL => {
  switch (sort) {
    case "relevance":
      return relevanceScore;
    case "newest":
      // Never null: `decisionDatedFilterSql` has already excluded the
      // decisions with no date, so the key needs no floor to put them at.
      return sql`extract(epoch FROM d.decision_date)`;
    default:
      sort satisfies never;
      return panic(`Unhandled search sort: ${String(sort)}`);
  }
};
