import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  decisionDateRankAfterSql,
  decisionDateRankSql,
} from "@/api/lib/case-law/decision-date-order";
import type { DecisionSearchCursor } from "@/api/lib/case-law/decision-search-cursor";
import type { SearchSort } from "@/api/lib/legal-search/corpus-search-order";

/**
 * The column the ORDER BY, the keyset predicate and the language-group
 * representative rule all read. One expression for the three, because keyset
 * pagination is only stable while they agree, and one per order, because the
 * order is what they have to agree about. The statement sorts it descending.
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
      // Undated decisions are listed after every dated one, as in every date
      // order (`decision-date-order.ts`).
      return decisionDateRankSql("newest", sql`d.decision_date`);
    default:
      sort satisfies never;
      return panic(`Unhandled search sort: ${String(sort)}`);
  }
};

/**
 * The matched rows after a cursor, compared on the materialized sort column
 * `decisionSortKeySql` wrote (`m.sort_key`), so the predicate and the ORDER BY
 * read one value.
 */
export const decisionSearchCursorAfterSql = (
  cursor: DecisionSearchCursor,
): SQL => {
  switch (cursor.sort) {
    case "relevance":
      return sql`(m.sort_key, m.decision_id) < (${cursor.sortKey}::float8, ${cursor.id})`;
    case "newest":
      return decisionDateRankAfterSql({
        order: "newest",
        position: cursor.position,
        rank: sql`m.sort_key`,
        id: sql`m.decision_id`,
      });
    default:
      cursor satisfies never;
      return panic(`Unhandled search cursor: ${String(cursor)}`);
  }
};
