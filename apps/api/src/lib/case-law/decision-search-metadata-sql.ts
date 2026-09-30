import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

/** Residual filters for indexed text matches or bounded decision-id lookups.
 * Structured categories are excluded; only strings the search input accepts
 * can match. These expressions do not need corpus-wide metadata indexes. */
export const decisionSearchCategorySql = (metadata: SQLWrapper) =>
  sql`(CASE WHEN jsonb_typeof(${metadata} -> 'category') = 'string'
    AND length(${metadata} ->> 'category') <= 128
    THEN ${metadata} ->> 'category' END)`;

export const decisionHasLegalSentenceSql = (metadata: SQLWrapper) =>
  sql`(coalesce(jsonb_typeof(${metadata} -> 'legalSentence') = 'string'
    AND length(btrim(${metadata} ->> 'legalSentence')) > 0, false))`;
