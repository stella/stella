import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import {
  storedDecisionTextAbsenceEntriesSql,
  storedDecisionTextAbsenceValidSql,
} from "@/api/lib/case-law/decision-text-sql";

/** Residual filters for bounded decision-id lookups.
 * Structured categories are excluded; only strings the search input accepts
 * can match. PostgreSQL text search refuses these unindexed filters. */
export const decisionSearchCategorySql = (metadata: SQLWrapper) =>
  sql`(CASE WHEN jsonb_typeof(${metadata} -> 'category') = 'string'
    AND length(${metadata} ->> 'category') <= 128
    THEN ${metadata} ->> 'category' END)`;

export const decisionHasLegalSentenceSql = (metadata: SQLWrapper) => {
  const absenceEntries = storedDecisionTextAbsenceEntriesSql(metadata);

  return sql`(coalesce(
    ${storedDecisionTextAbsenceValidSql(metadata, absenceEntries)}
    AND NOT ${absenceEntries} @> jsonb_build_array(
      jsonb_build_object('field', 'legalSentence')
    )
    AND jsonb_typeof(${metadata} -> 'legalSentence') = 'string'
    AND length(btrim(${metadata} ->> 'legalSentence')) > 0,
    false
  ))`;
};
