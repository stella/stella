import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { bodyPreviewJoin } from "@/api/handlers/case-law/decisions/search-sql";
import { loadDocumentContext } from "@/api/lib/legal-search/document-context";
import type {
  LegalSearchHit,
  LegalSearchProvider,
  LegalSearchQuery,
  LegalSearchResult,
} from "@/api/lib/legal-search/types";
import { LIMITS } from "@/api/lib/limits";
import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";
import {
  escapeAndHighlight,
  TS_HEADLINE_CONFIG,
} from "@/api/lib/search/highlight";

/**
 * Postgres FTS legal-search provider — the shipped case-law search,
 * adapted to read the materialized `citation_authority` column instead
 * of recomputing the citation-graph LATERAL per query. This is the
 * cutover-safe default while Quickwit is validated.
 */

type RawRow = Record<string, unknown>;
type RawRows = RawRow[];

const toNullableString = (x: unknown): string | null =>
  x === null ? null : JSON.stringify(x);

// Per-document language config is mixed; 'simple' + unaccent matches the
// index-time tsvector and the shipped handler.
const headlineRegconfig = sql`'public.stella_unaccent'::regconfig`;

const search = async (query: LegalSearchQuery): Promise<LegalSearchResult> => {
  const limit = query.limit;
  const tsQuery = sql`plainto_tsquery('simple', unaccent(${query.query}))`;

  const parsedCursor = query.cursor ? decodeCursor(query.cursor) : null;

  // Filters. jurisdiction -> country, documentType -> decision_type.
  const courtFilter = query.court ? sql`AND d.court = ${query.court}` : sql``;
  const countryFilter = query.jurisdiction
    ? sql`AND d.country = ${query.jurisdiction}`
    : sql``;
  const dateFromFilter = query.dateFrom
    ? sql`AND d.decision_date >= ${query.dateFrom}`
    : sql``;
  const dateToFilter = query.dateTo
    ? sql`AND d.decision_date <= ${query.dateTo}`
    : sql``;
  const typeFilter = query.documentType
    ? sql`AND d.decision_type = ${query.documentType}`
    : sql``;
  const sourceFilter = query.source
    ? sql`AND d.source_id = ${query.source}`
    : sql``;
  const languageFilter = query.language
    ? sql`AND d.language = ${query.language}`
    : sql``;

  const scoreExpr = sql`(ts_rank(sd.tsv, ${tsQuery})::float8 + 0.3 * d.citation_authority)`;

  const cursorFilter = parsedCursor
    ? sql`AND (${scoreExpr}, sd.decision_id) < (${parsedCursor.score}::float8, ${parsedCursor.id})`
    : sql``;

  const allFilters = sql`
    ${courtFilter}
    ${countryFilter}
    ${dateFromFilter}
    ${dateToFilter}
    ${typeFilter}
    ${sourceFilter}
    ${languageFilter}
  `;

  const hitsQuery = sql`
    SELECT
      sd.decision_id,
      d.case_number,
      d.ecli,
      d.court,
      d.country,
      d.language,
      d.decision_date,
      d.decision_type,
      d.source_url,
      ts_headline(
        ${headlineRegconfig},
        coalesce(nullif(body_preview.text, ''), d.fulltext, sd.searchable_text),
        ${tsQuery},
        ${TS_HEADLINE_CONFIG}
      ) AS headline,
      ${scoreExpr} AS score,
      d.citation_count,
      d.citation_authority,
      d.created_at
    FROM case_law_search_documents sd
    JOIN case_law_decisions d
      ON d.id = sd.decision_id
    ${bodyPreviewJoin}
    WHERE sd.tsv @@ ${tsQuery}
      ${allFilters}
      ${cursorFilter}
    ORDER BY score DESC, sd.decision_id DESC
    LIMIT ${limit + 1}
  `;

  const facetQuery = (
    omit: "court" | "country" | "language",
    column: "court" | "country" | "language",
  ) => sql`
    SELECT d.${sql.raw(column)} AS value, count(*)::int AS count
    FROM case_law_search_documents sd
    JOIN case_law_decisions d ON d.id = sd.decision_id
    WHERE sd.tsv @@ ${tsQuery}
      ${omit === "court" ? sql`` : courtFilter}
      ${omit === "country" ? sql`` : countryFilter}
      ${omit === "language" ? sql`` : languageFilter}
      ${dateFromFilter}
      ${dateToFilter}
      ${typeFilter}
      ${sourceFilter}
    GROUP BY d.${sql.raw(column)}
    ORDER BY count DESC
    LIMIT ${LIMITS.caseLawFacetLimit}
  `;

  const emptyRows: Promise<RawRows> = Promise.resolve([]);
  // Facets don't change between pages; skip them on cursor requests.
  const [hitsRaw, courtRaw, countryRaw, languageRaw] = await Promise.all([
    rootDb.execute(hitsQuery),
    parsedCursor ? emptyRows : rootDb.execute(facetQuery("court", "court")),
    parsedCursor ? emptyRows : rootDb.execute(facetQuery("country", "country")),
    parsedCursor
      ? emptyRows
      : rootDb.execute(facetQuery("language", "language")),
  ]);

  const hitsResult: RawRows = hitsRaw ?? [];
  const hasMore = hitsResult.length > limit;
  const resultRows = hasMore ? hitsResult.slice(0, limit) : hitsResult;

  const lastRaw = resultRows.at(-1);
  const nextCursor =
    hasMore && lastRaw
      ? encodeCursor(Number(lastRaw["score"]), String(lastRaw["decision_id"]))
      : null;

  const hits: LegalSearchHit[] = resultRows.map((row) => ({
    decisionId: String(row["decision_id"]),
    caseNumber: String(row["case_number"]),
    ecli: toNullableString(row["ecli"]),
    court: String(row["court"]),
    country: String(row["country"]),
    language: String(row["language"]),
    decisionDate: toNullableString(row["decision_date"]),
    decisionType: toNullableString(row["decision_type"]),
    sourceUrl: toNullableString(row["source_url"]),
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- row.headline from DB (any)
    headline: row["headline"]
      ? escapeAndHighlight(JSON.stringify(row["headline"]))
      : null,
    citationCount: Number(row["citation_count"]) || 0,
    citationAuthority: Number(row["citation_authority"]) || 0,
    score: Number(row["score"]) || 0,
    createdAt:
      row["created_at"] instanceof Date
        ? row["created_at"].toISOString()
        : String(row["created_at"]),
  }));

  const mapFacet = (rows: RawRows) =>
    rows.map((row) => ({
      value: String(row["value"]),
      count: Number(row["count"]),
    }));

  const facets = parsedCursor
    ? null
    : {
        court: mapFacet(courtRaw ?? []),
        country: mapFacet(countryRaw ?? []),
        language: mapFacet(languageRaw ?? []),
      };

  return { hits, facets, nextCursor, limit };
};

export const pgFtsLegalProvider: LegalSearchProvider = {
  search,
  getDocumentContext: loadDocumentContext,
};
