import { sql } from "drizzle-orm";

import { redistributableCaseLawSource } from "@/api/handlers/case-law/redistribution";

/**
 * Query-time redistribution gate for the raw pg-fts queries (which join
 * `case_law_decisions d`). The projection is also gated at index time;
 * this keeps stale projection rows of a source that later turned
 * restricted out of public results.
 */
export const redistributableSourceJoin = sql`
  JOIN case_law_sources
    ON case_law_sources.id = d.source_id
   AND ${redistributableCaseLawSource}
`;

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
