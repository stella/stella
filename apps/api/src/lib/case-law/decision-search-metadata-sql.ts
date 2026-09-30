import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

/** Shared with the expression indexes; keep JSON keys literal for index matching.
 * Bound category strings to the accepted input length so arbitrary metadata
 * cannot exceed a B-tree tuple's byte budget. */
export const decisionSearchCategorySql = (metadata: SQLWrapper) =>
  sql`(CASE WHEN jsonb_typeof(${metadata} -> 'category') = 'string'
    AND length(${metadata} ->> 'category') <= 128
    THEN ${metadata} ->> 'category' END)`;

export const decisionHasLegalSentenceSql = (metadata: SQLWrapper) =>
  sql`(coalesce(jsonb_typeof(${metadata} -> 'legalSentence') = 'string'
    AND length(btrim(${metadata} ->> 'legalSentence')) > 0, false))`;
