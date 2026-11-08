import { panic } from "better-result";
import { and, eq, type SQL, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  caseLawSearchDocuments,
  caseLawSources,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import type { LegalSearchEngine } from "@/api/lib/legal-search/types";

/**
 * The source gate for raw pg-fts queries. The base decision comes from the
 * published view, which applies its own visibility condition.
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

/**
 * The projection text of a decision a search hit may still show: published,
 * from a redistributable source. The same gate as `publicCaseLawDecisionJoin`,
 * read at use rather than trusted from the hit. `null` when no row qualifies.
 */
export const readPublicCaseLawSearchText = async (
  tx: Transaction,
  decisionId: SafeId<"caseLawDecision">,
): Promise<string | null> => {
  const rows = await tx
    .select({ searchableText: caseLawSearchDocuments.searchableText })
    .from(caseLawSearchDocuments)
    .innerJoin(
      publishedCaseLawDecisions,
      eq(publishedCaseLawDecisions.id, caseLawSearchDocuments.decisionId),
    )
    .innerJoin(
      caseLawSources,
      and(
        eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
        redistributableCaseLawSource,
      ),
    )
    .where(eq(caseLawSearchDocuments.decisionId, decisionId))
    .limit(1);
  return rows.at(0)?.searchableText ?? null;
};

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

/** SQL serving membership for a decision already admitted by the published view. */
export const servedCaseLawSearchDocumentFor = (
  decisionAlias: string,
  engine: LegalSearchEngine,
): SQL | null => {
  switch (engine) {
    case "pg-fts":
      return sql`EXISTS (
        SELECT 1 FROM ${caseLawSearchDocuments}
        WHERE ${caseLawSearchDocuments.decisionId} = ${sql.identifier(decisionAlias)}.id
      )`;
    case "corpus-index":
      return null;
    default:
      engine satisfies never;
      return panic("Unhandled serving provider");
  }
};
