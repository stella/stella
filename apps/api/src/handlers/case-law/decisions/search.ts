import { sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { courtWeightSql } from "@/api/handlers/case-law/citation-score";
import { bodyPreviewJoin } from "@/api/handlers/case-law/decisions/search-sql";
import { LIMITS } from "@/api/lib/limits";
import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";
import {
  escapeAndHighlight,
  TS_HEADLINE_CONFIG,
} from "@/api/lib/search/highlight";

const toNullableString = (x: unknown): string | null =>
  x === null ? null : JSON.stringify(x);

const headlineRegconfig = sql`
  'public.stella_unaccent'::regconfig
`;

export const searchDecisionsBodySchema = t.Object({
  query: t.String({
    minLength: 1,
    maxLength: LIMITS.searchQueryMaxLength,
  }),
  limit: t.Optional(
    t.Number({
      minimum: 1,
      maximum: LIMITS.caseLawSearchPageSizeMax,
    }),
  ),
  cursor: t.Optional(t.String()),
  court: t.Optional(t.String({ maxLength: 512 })),
  country: t.Optional(t.String({ maxLength: 3 })),
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
  decisionType: t.Optional(t.String({ maxLength: 128 })),
  sourceId: t.Optional(t.String({ maxLength: 36 })),
  language: t.Optional(t.String({ maxLength: 8 })),
});

type SearchDecisionsBody = Static<typeof searchDecisionsBodySchema>;

export const searchDecisionsHandler = async (
  body: SearchDecisionsBody,
  scopedDb: ScopedDb,
) => {
  const limit = body.limit ?? LIMITS.caseLawSearchPageSizeDefault;
  const tsQuery = sql`plainto_tsquery('simple', unaccent(${body.query}))`;

  // Validate cursor early so a tampered value fails visibly
  let parsedCursor: { score: number; id: string } | null = null;
  if (body.cursor) {
    parsedCursor = decodeCursor(body.cursor);
    if (!parsedCursor) {
      return status(400, { message: "Invalid cursor" });
    }
  }

  // Optional filters on the decisions table
  const courtFilter = body.court ? sql`AND d.court = ${body.court}` : sql``;
  const countryFilter = body.country
    ? sql`AND d.country = ${body.country}`
    : sql``;
  const dateFromFilter = body.dateFrom
    ? sql`AND d.decision_date >= ${body.dateFrom}`
    : sql``;
  const dateToFilter = body.dateTo
    ? sql`AND d.decision_date <= ${body.dateTo}`
    : sql``;
  const typeFilter = body.decisionType
    ? sql`AND d.decision_type = ${body.decisionType}`
    : sql``;
  const sourceFilter = body.sourceId
    ? sql`AND d.source_id = ${body.sourceId}`
    : sql``;
  const languageFilter = body.language
    ? sql`AND d.language = ${body.language}`
    : sql``;

  const cursorFilter = parsedCursor
    ? sql`AND (
        (ts_rank(sd.tsv, ${tsQuery})::float8
          + 0.3 * ln(1 + cb.boost)),
        sd.decision_id
      ) < (
        ${parsedCursor.score}::float8,
        ${parsedCursor.id}
      )`
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

  const courtWeightExpr = courtWeightSql("citing_d.court");

  const citationBoost = sql.raw(`
    LATERAL (
      SELECT coalesce(
        sum(
          (${courtWeightExpr})
          * (1.0 / (1 + COALESCE(extract(epoch FROM (now() - citing_d.decision_date)) / (365.25 * 86400), 1.0)))
        ),
        0
      ) / GREATEST(
        extract(epoch FROM (now() - d.decision_date)) / (365.25 * 86400),
        1.0
      ) AS boost,
      count(*)::int AS cnt
      FROM case_law_citations c
      JOIN case_law_decisions citing_d
        ON citing_d.id = c.citing_decision_id
      WHERE c.cited_decision_id = d.id
    ) cb
  `);

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
      (ts_rank(sd.tsv, ${tsQuery})::float8
        + 0.3 * ln(1 + cb.boost)
      ) AS score,
      cb.cnt AS citation_count,
      d.created_at
    FROM case_law_search_documents sd
    JOIN case_law_decisions d
      ON d.id = sd.decision_id
    ${bodyPreviewJoin}
    LEFT JOIN ${citationBoost} ON true
    WHERE sd.tsv @@ ${tsQuery}
      ${allFilters}
      ${cursorFilter}
    ORDER BY score DESC, sd.decision_id DESC
    LIMIT ${limit + 1}
  `;

  const countQuery = sql`
    SELECT count(*)::int AS total
    FROM case_law_search_documents sd
    JOIN case_law_decisions d
      ON d.id = sd.decision_id
    WHERE sd.tsv @@ ${tsQuery}
      ${allFilters}
  `;

  // Court facet: cross-filtered (respects country + language)
  const courtFacetQuery = sql`
    SELECT d.court AS value, count(*)::int AS count
    FROM case_law_search_documents sd
    JOIN case_law_decisions d
      ON d.id = sd.decision_id
    WHERE sd.tsv @@ ${tsQuery}
      ${countryFilter}
      ${dateFromFilter}
      ${dateToFilter}
      ${typeFilter}
      ${sourceFilter}
      ${languageFilter}
    GROUP BY d.court
    ORDER BY count DESC
    LIMIT ${LIMITS.caseLawFacetLimit}
  `;

  // Country facet: cross-filtered (respects court + language)
  const countryFacetQuery = sql`
    SELECT d.country AS value, count(*)::int AS count
    FROM case_law_search_documents sd
    JOIN case_law_decisions d
      ON d.id = sd.decision_id
    WHERE sd.tsv @@ ${tsQuery}
      ${courtFilter}
      ${dateFromFilter}
      ${dateToFilter}
      ${typeFilter}
      ${sourceFilter}
      ${languageFilter}
    GROUP BY d.country
    ORDER BY count DESC
    LIMIT ${LIMITS.caseLawFacetLimit}
  `;

  // Language facet: cross-filtered (respects court + country)
  const languageFacetQuery = sql`
    SELECT d.language AS value, count(*)::int AS count
    FROM case_law_search_documents sd
    JOIN case_law_decisions d
      ON d.id = sd.decision_id
    WHERE sd.tsv @@ ${tsQuery}
      ${courtFilter}
      ${countryFilter}
      ${dateFromFilter}
      ${dateToFilter}
      ${typeFilter}
      ${sourceFilter}
    GROUP BY d.language
    ORDER BY count DESC
    LIMIT ${LIMITS.caseLawFacetLimit}
  `;

  type RawRows = Record<string, unknown>[];
  const emptyRows: Promise<RawRows> = Promise.resolve([]);

  // Skip expensive COUNT(*) and facet queries on paginated
  // requests; these values don't change between pages.
  const queries: Promise<RawRows>[] = [
    scopedDb((tx) => tx.execute(hitsQuery)),
    parsedCursor ? emptyRows : scopedDb((tx) => tx.execute(countQuery)),
    parsedCursor ? emptyRows : scopedDb((tx) => tx.execute(courtFacetQuery)),
    parsedCursor ? emptyRows : scopedDb((tx) => tx.execute(countryFacetQuery)),
    parsedCursor ? emptyRows : scopedDb((tx) => tx.execute(languageFacetQuery)),
  ];

  const [
    hitsResultRaw,
    countResultRaw,
    courtResultRaw,
    countryResultRaw,
    languageResultRaw,
  ] = await Promise.all(queries);

  const hitsResult = hitsResultRaw ?? [];
  const countResult = countResultRaw ?? [];
  const courtResult = courtResultRaw ?? [];
  const countryResult = countryResultRaw ?? [];
  const languageResult = languageResultRaw ?? [];

  const hasMore = hitsResult.length > limit;
  const resultRows = hasMore ? hitsResult.slice(0, limit) : hitsResult;

  const lastRaw = resultRows.at(-1);
  const nextCursor =
    hasMore && lastRaw
      ? encodeCursor(Number(lastRaw["score"]), String(lastRaw["decision_id"]))
      : null;

  const hits = resultRows.map((row) => ({
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
    createdAt:
      row["created_at"] instanceof Date
        ? row["created_at"].toISOString()
        : String(row["created_at"]),
  }));

  const totalCount = parsedCursor
    ? null
    : Number(countResult.at(0)?.["total"]) || 0;

  const facets = parsedCursor
    ? null
    : {
        court: courtResult.map((row) => ({
          value: String(row["value"]),
          count: Number(row["count"]),
        })),
        country: countryResult.map((row) => ({
          value: String(row["value"]),
          count: Number(row["count"]),
        })),
        language: languageResult.map((row) => ({
          value: String(row["value"]),
          count: Number(row["count"]),
        })),
      };

  return {
    hits,
    facets,
    totalCount,
    nextCursor,
  };
};
