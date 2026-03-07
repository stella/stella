import { sql } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { LIMITS } from "@/api/lib/limits";
import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";
import {
  escapeAndHighlight,
  TS_HEADLINE_CONFIG,
} from "@/api/lib/search/highlight";

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
  sourceId: t.Optional(t.String({ maxLength: 21 })),
});

type SearchDecisionsBody = Static<typeof searchDecisionsBodySchema>;

export const searchDecisionsHandler = async (body: SearchDecisionsBody) => {
  const limit = body.limit ?? LIMITS.caseLawSearchPageSizeDefault;
  const tsQuery = sql`plainto_tsquery('simple', ${body.query})`;

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

  const cursorFilter = parsedCursor
    ? sql`AND (
        ts_rank(sd.tsv, ${tsQuery})::float8,
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
        'simple',
        sd.title || ' ' ||
          left(sd.searchable_text, 2000),
        ${tsQuery},
        ${TS_HEADLINE_CONFIG}
      ) AS headline,
      ts_rank(sd.tsv, ${tsQuery})::float8 AS score,
      d.created_at
    FROM case_law_search_documents sd
    JOIN case_law_decisions d
      ON d.id = sd.decision_id
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

  // Court facet: cross-filtered (respects country filter)
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
    GROUP BY d.court
    ORDER BY count DESC
    LIMIT ${LIMITS.caseLawFacetLimit}
  `;

  // Country facet: cross-filtered (respects court filter)
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
    GROUP BY d.country
    ORDER BY count DESC
    LIMIT ${LIMITS.caseLawFacetLimit}
  `;

  const emptyRows = Promise.resolve({
    rows: [] as Record<string, unknown>[],
  });

  // Skip expensive COUNT(*) and facet queries on paginated
  // requests; these values don't change between pages.
  const queries: Promise<{ rows: Record<string, unknown>[] }>[] = [
    db.execute(hitsQuery),
    parsedCursor ? emptyRows : db.execute(countQuery),
    parsedCursor ? emptyRows : db.execute(courtFacetQuery),
    parsedCursor ? emptyRows : db.execute(countryFacetQuery),
  ];

  const [hitsResult, countResult, courtResult, countryResult] =
    await Promise.all(queries);

  const hasMore = hitsResult.rows.length > limit;
  const resultRows = hasMore
    ? hitsResult.rows.slice(0, limit)
    : hitsResult.rows;

  const lastRaw = resultRows.at(-1);
  const nextCursor =
    hasMore && lastRaw
      ? encodeCursor(Number(lastRaw.score), String(lastRaw.decision_id))
      : null;

  const hits = resultRows.map((row) => ({
    decisionId: String(row.decision_id),
    caseNumber: String(row.case_number),
    ecli: row.ecli ? String(row.ecli) : null,
    court: String(row.court),
    country: String(row.country),
    language: String(row.language),
    decisionDate: row.decision_date ? String(row.decision_date) : null,
    decisionType: row.decision_type ? String(row.decision_type) : null,
    sourceUrl: row.source_url ? String(row.source_url) : null,
    headline: row.headline ? escapeAndHighlight(String(row.headline)) : null,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
  }));

  const totalCount = parsedCursor
    ? null
    : Number(countResult.rows.at(0)?.total) || 0;

  const facets = parsedCursor
    ? null
    : {
        court: courtResult.rows.map((row) => ({
          value: String(row.value),
          count: Number(row.count),
        })),
        country: countryResult.rows.map((row) => ({
          value: String(row.value),
          count: Number(row.count),
        })),
      };

  return {
    hits,
    facets,
    totalCount,
    nextCursor,
  };
};
