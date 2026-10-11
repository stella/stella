import { sql } from "drizzle-orm";

import { publishedCaseLawDecisionSqlFor } from "@/api/lib/case-law/published-decisions";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";

/**
 * The source gate for raw pg-fts queries. Pair it with
 * publicCaseLawDecisionWhere to filter the base decision row.
 *
 * Both halves are query-time as well as index-time. The projection is gated
 * when it is written, so this keeps out rows indexed before a source turned
 * restricted, and rows indexed before their listing-only marker was read here
 * — a listing-only row has a docket and a court, so it produces a search
 * document even with no body to preview.
 */
export const publicCaseLawDecisionJoin = sql`
  JOIN case_law_sources
    ON case_law_sources.id = d.source_id
   AND ${redistributableCaseLawSource}
`;

/** Positive filter for the decision row introduced before the source join. */
export const publicCaseLawDecisionWhere = sql.raw(
  publishedCaseLawDecisionSqlFor("d"),
);

export const bodyPreviewJoin = sql`
  LEFT JOIN LATERAL (
    SELECT string_agg(
      section_item.value ->> 'text',
      ' '
      ORDER BY (section_item.value ->> 'index')::int
    ) AS text
    FROM jsonb_array_elements(
      CASE jsonb_typeof(d.sections)
        WHEN 'array' THEN d.sections
        ELSE '[]'::jsonb
      END
    ) section_item(value)
    WHERE section_item.value ->> 'type' <> 'header'
      AND nullif(section_item.value ->> 'text', '') IS NOT NULL
  ) body_preview ON true
`;
