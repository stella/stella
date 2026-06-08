import { inArray, sql } from "drizzle-orm";
import { status } from "elysia";
import type { Static } from "elysia";

import { caseLawDecisions } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { courtWeightSql } from "@/api/handlers/case-law/citation-score";
import { validCaseLawLanguageAlternateCountSql } from "@/api/handlers/case-law/decisions/language";
import type { searchDecisionsBodySchema } from "@/api/handlers/case-law/decisions/search-schema";
import { bodyPreviewJoin } from "@/api/handlers/case-law/decisions/search-sql";
// eslint-disable-next-line no-restricted-imports -- search boundary: brands document ids returned by the corpus index before re-hydrating from Postgres
import { toSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { isUuid } from "@/api/lib/custom-schema";
import { corpusGeneration } from "@/api/lib/legal-search/corpus-family";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import {
  corpusIndexId,
  corpusIndexPattern,
  isCorpusIndexJurisdiction,
} from "@/api/lib/legal-search/index-naming";
import {
  blendCitationAuthority,
  type ScoredCandidate,
} from "@/api/lib/legal-search/rerank";
import { LIMITS } from "@/api/lib/limits";
import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";
import {
  escapeAndHighlight,
  TS_HEADLINE_CONFIG,
} from "@/api/lib/search/highlight";

const toNullableString = (x: unknown): string | null => {
  if (x === null || x === undefined) {
    return null;
  }

  if (typeof x === "string") {
    return x;
  }

  if (typeof x === "number" || typeof x === "boolean") {
    return x.toString();
  }

  if (x instanceof Date) {
    return x.toISOString();
  }

  return JSON.stringify(x);
};

const headlineRegconfig = sql`
  'public.stella_unaccent'::regconfig
`;

type SearchDecisionsBody = Static<typeof searchDecisionsBodySchema>;

export const searchDecisionsHandler = async (
  body: SearchDecisionsBody,
  caseLawDb: CaseLawPublicReadDb,
) => {
  if (envBase.LEGAL_SEARCH_PROVIDER === "corpus-index") {
    return await searchCorpusIndexDecisions(body, caseLawDb);
  }

  return await searchPostgresDecisions(body, caseLawDb);
};

const searchPostgresDecisions = async (
  body: SearchDecisionsBody,
  caseLawDb: CaseLawPublicReadDb,
) => {
  const limit = body.limit ?? LIMITS.caseLawSearchPageSizeDefault;
  const tsQuery = sql`plainto_tsquery('simple', unaccent(${body.query}))`;

  // Validate cursor early so a tampered value fails visibly
  let parsedCursor: { score: number; id: string } | null = null;
  if (body.cursor) {
    parsedCursor = decodeCursor(body.cursor);
    if (!parsedCursor || !isUuid(parsedCursor.id)) {
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
      d.slug,
      d.ecli,
      d.court,
      d.country,
      d.language,
      d.language_group_key,
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
    caseLawDb((tx) => tx.execute(hitsQuery)),
    parsedCursor ? emptyRows : caseLawDb((tx) => tx.execute(countQuery)),
    parsedCursor ? emptyRows : caseLawDb((tx) => tx.execute(courtFacetQuery)),
    parsedCursor ? emptyRows : caseLawDb((tx) => tx.execute(countryFacetQuery)),
    parsedCursor
      ? emptyRows
      : caseLawDb((tx) => tx.execute(languageFacetQuery)),
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
  const languageGroupKeys = [
    ...new Set(
      resultRows
        .map((row) => toNullableString(row["language_group_key"]))
        .filter((value): value is string => value !== null),
    ),
  ];
  const languageAlternateCounts =
    languageGroupKeys.length > 0
      ? await caseLawDb((tx) =>
          tx
            .select({
              languageGroupKey: caseLawDecisions.languageGroupKey,
              count: validCaseLawLanguageAlternateCountSql,
            })
            .from(caseLawDecisions)
            .where(
              inArray(caseLawDecisions.languageGroupKey, languageGroupKeys),
            )
            .groupBy(caseLawDecisions.languageGroupKey),
        )
      : [];
  const languageAlternateCountByGroupKey = new Map(
    languageAlternateCounts
      .filter(
        (
          row,
        ): row is {
          count: number;
          languageGroupKey: string;
        } => row.languageGroupKey !== null,
      )
      .map((row) => [row.languageGroupKey, row.count]),
  );

  const lastRaw = resultRows.at(-1);
  const nextCursor =
    hasMore && lastRaw
      ? encodeCursor(Number(lastRaw["score"]), String(lastRaw["decision_id"]))
      : null;

  const hits = resultRows.map((row) => {
    const languageGroupKey = toNullableString(row["language_group_key"]);

    return {
      decisionId: String(row["decision_id"]),
      caseNumber: String(row["case_number"]),
      slug: toNullableString(row["slug"]),
      ecli: toNullableString(row["ecli"]),
      court: String(row["court"]),
      country: String(row["country"]),
      language: String(row["language"]),
      languageAlternateCount:
        languageGroupKey === null
          ? 0
          : (languageAlternateCountByGroupKey.get(languageGroupKey) ?? 1),
      languageGroupKey,
      decisionDate: toNullableString(row["decision_date"]),
      decisionType: toNullableString(row["decision_type"]),
      sourceUrl: toNullableString(row["source_url"]),
      // oxlint-disable-next-line typescript/strict-boolean-expressions -- row.headline from DB (any)
      headline: row["headline"]
        ? escapeAndHighlight(toNullableString(row["headline"]) ?? "")
        : null,
      citationCount: Number(row["citation_count"]) || 0,
      createdAt:
        row["created_at"] instanceof Date
          ? row["created_at"].toISOString()
          : String(row["created_at"]),
    };
  });

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

const quoteCorpusIndexValue = (value: string): string =>
  `"${value.replaceAll('"', '\\"')}"`;

const buildCorpusIndexQuery = (body: SearchDecisionsBody): string => {
  const clauses: string[] = [`(${body.query})`];
  if (body.decisionType) {
    clauses.push(`document_type:${quoteCorpusIndexValue(body.decisionType)}`);
  }
  if (body.sourceId) {
    clauses.push(`source:${quoteCorpusIndexValue(body.sourceId)}`);
  }
  if (body.language) {
    clauses.push(`language:${quoteCorpusIndexValue(body.language)}`);
  }
  if (body.court) {
    clauses.push(`court:${quoteCorpusIndexValue(body.court)}`);
  }
  if (body.dateFrom || body.dateTo) {
    clauses.push(
      `decision_date:[${body.dateFrom ?? "*"} TO ${body.dateTo ?? "*"}]`,
    );
  }
  return clauses.join(" AND ");
};

const extractCorpusSnippet = (
  snippet: Record<string, unknown> | undefined,
): string | null => {
  const text = snippet?.["text"];
  const raw = Array.isArray(text) ? text.join(" … ") : text;
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  return raw.replaceAll("<b>", "<mark>").replaceAll("</b>", "</mark>");
};

const isAfterCursor = (
  hit: { score: number; id: string },
  cursor: { score: number; id: string },
): boolean => {
  if (hit.score < cursor.score) {
    return true;
  }
  if (hit.score > cursor.score) {
    return false;
  }
  return hit.id < cursor.id;
};

const searchCorpusIndexDecisions = async (
  body: SearchDecisionsBody,
  caseLawDb: CaseLawPublicReadDb,
) => {
  const limit = body.limit ?? LIMITS.caseLawSearchPageSizeDefault;

  let parsedCursor: { score: number; id: string } | null = null;
  if (body.cursor) {
    parsedCursor = decodeCursor(body.cursor);
    if (!parsedCursor || !isUuid(parsedCursor.id)) {
      return status(400, { message: "Invalid cursor" });
    }
  }

  if (body.country !== undefined && !isCorpusIndexJurisdiction(body.country)) {
    return status(400, { message: "Invalid country" });
  }

  const generation = corpusGeneration("case_law");
  const indexId = body.country
    ? corpusIndexId(generation, body.country)
    : corpusIndexPattern(generation);

  const result = await getCorpusIndexClient().search({
    indexId,
    query: buildCorpusIndexQuery(body),
    maxHits: LIMITS.corpusIndexSearchCandidateLimit,
    snippetFields: ["text"],
  });
  if (result.isErr()) {
    throw result.error;
  }

  const candidates: ScoredCandidate[] = [];
  const snippetById = new Map<string, string>();
  const seenIds = new Set<string>();
  for (const [index, hit] of result.value.hits.entries()) {
    const id = hit["document_id"];
    if (typeof id !== "string" || !isUuid(id) || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);
    // Descending pseudo-score preserves corpus index BM25 ordering as the
    // lexical signal for the citation-authority blend.
    candidates.push({ id, score: result.value.hits.length - index });
    const snippet = extractCorpusSnippet(result.value.snippets[index]);
    if (snippet !== null) {
      snippetById.set(id, snippet);
    }
  }

  const ids = candidates.map((candidate) =>
    toSafeId<"caseLawDecision">(candidate.id),
  );
  const rows =
    ids.length === 0
      ? []
      : await caseLawDb((tx) =>
          tx
            .select({
              id: caseLawDecisions.id,
              caseNumber: caseLawDecisions.caseNumber,
              slug: caseLawDecisions.slug,
              ecli: caseLawDecisions.ecli,
              court: caseLawDecisions.court,
              country: caseLawDecisions.country,
              language: caseLawDecisions.language,
              languageGroupKey: caseLawDecisions.languageGroupKey,
              decisionDate: caseLawDecisions.decisionDate,
              decisionType: caseLawDecisions.decisionType,
              sourceUrl: caseLawDecisions.sourceUrl,
              citationCount: caseLawDecisions.citationCount,
              citationAuthority: caseLawDecisions.citationAuthority,
              createdAt: caseLawDecisions.createdAt,
            })
            .from(caseLawDecisions)
            .where(inArray(caseLawDecisions.id, ids)),
        );

  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const authorityById = new Map(
    rows.map((row) => [String(row.id), row.citationAuthority]),
  );
  const ranked = blendCitationAuthority({
    candidates: candidates.filter((candidate) => byId.has(candidate.id)),
    authorityById,
  });

  const windowed = parsedCursor
    ? ranked.filter((hit) => isAfterCursor(hit, parsedCursor))
    : ranked;
  const hasMore = windowed.length > limit;
  const pageRanked = hasMore ? windowed.slice(0, limit) : windowed;

  const languageGroupKeys = [
    ...new Set(
      pageRanked
        .map((hit) => byId.get(hit.id)?.languageGroupKey ?? null)
        .filter((value): value is string => value !== null),
    ),
  ];
  const languageAlternateCounts =
    languageGroupKeys.length > 0
      ? await caseLawDb((tx) =>
          tx
            .select({
              languageGroupKey: caseLawDecisions.languageGroupKey,
              count: validCaseLawLanguageAlternateCountSql,
            })
            .from(caseLawDecisions)
            .where(
              inArray(caseLawDecisions.languageGroupKey, languageGroupKeys),
            )
            .groupBy(caseLawDecisions.languageGroupKey),
        )
      : [];
  const languageAlternateCountByGroupKey = new Map(
    languageAlternateCounts
      .filter(
        (
          row,
        ): row is {
          count: number;
          languageGroupKey: string;
        } => row.languageGroupKey !== null,
      )
      .map((row) => [row.languageGroupKey, row.count]),
  );

  const last = pageRanked.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.score, last.id) : null;

  const hits = pageRanked.flatMap((hit) => {
    const row = byId.get(hit.id);
    if (!row) {
      return [];
    }

    return [
      {
        decisionId: row.id,
        caseNumber: row.caseNumber,
        slug: row.slug,
        ecli: row.ecli,
        court: row.court,
        country: row.country,
        language: row.language,
        languageAlternateCount:
          row.languageGroupKey === null
            ? 0
            : (languageAlternateCountByGroupKey.get(row.languageGroupKey) ?? 1),
        languageGroupKey: row.languageGroupKey,
        decisionDate: row.decisionDate,
        decisionType: row.decisionType,
        sourceUrl: row.sourceUrl,
        headline: snippetById.get(hit.id) ?? null,
        citationCount: row.citationCount,
        createdAt: row.createdAt.toISOString(),
      },
    ];
  });

  return {
    hits,
    facets: null,
    totalCount: null,
    nextCursor,
  };
};
