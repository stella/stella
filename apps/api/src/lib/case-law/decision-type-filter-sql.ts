import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import { DECISION_TYPE_KIND_OTHER } from "@stll/api-contract/case-law-decision-types";

import {
  decisionTypeFilter,
  DECISION_TYPE_KIND_BY_KEY,
} from "@/api/lib/case-law/decision-type-kind";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

/**
 * A stored decision type's canonical kind, as the database computes it: the
 * same key table `decisionTypeKind` reads, folded by the database's own
 * `lower()`. The facet groups by this expression and the filter compares
 * against it, so a bucket's count and the rows its filter returns are one
 * derivation.
 */
export const decisionTypeKindSql = (column: SQLWrapper): SQL =>
  sql`(${sqlCaseFragment({
    operand: sql`lower(${column})`,
    branches: [...DECISION_TYPE_KIND_BY_KEY].map(
      ([key, kind]) => sql`WHEN ${key}::text THEN ${kind}::text`,
    ),
    fallback: sql`${DECISION_TYPE_KIND_OTHER}::text`,
  })})`;

/**
 * Rows whose decision type answers a request's `decisionType`: a canonical
 * kind, or any stated spelling of one (which selects the whole kind), or, for
 * a value no kind claims, that value under the same case folding.
 */
export const decisionTypeFilterSql = (
  column: SQLWrapper,
  requested: string,
): SQL => {
  const filter = decisionTypeFilter(requested);
  switch (filter.type) {
    case "kind":
      return sql`(${column} IS NOT NULL AND ${decisionTypeKindSql(column)} = ${filter.kind}::text)`;
    case "stated":
      return sql`lower(${column}) = lower(${filter.stated})`;
    default:
      filter satisfies never;
      return panic(`Unhandled decision type filter: ${String(filter)}`);
  }
};
