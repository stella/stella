import { Result } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { redistributableLegislationSource } from "@/api/handlers/legislation/redistribution";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
// eslint-disable-next-line no-restricted-imports -- search boundary: brands document ids returned by the corpus index before re-hydrating from Postgres
import { toSafeId } from "@/api/lib/branded-types";
import {
  isUuid,
  tPaginationCursor,
  tPaginationLimit,
  tSafeId,
} from "@/api/lib/custom-schema";
import {
  blendedRankSql,
  noCourtTierSql,
} from "@/api/lib/legal-search/authority-sql";
import { readServingCorpusIndexGenerationTx } from "@/api/lib/legal-search/corpus-index-generation-store";
import type { SearchCursor } from "@/api/lib/legal-search/corpus-index-pagination";
import { readCorpusIndexSearchPage } from "@/api/lib/legal-search/corpus-index-pagination";
import {
  corpusFreeTextClause,
  quoteCorpusValue,
} from "@/api/lib/legal-search/corpus-query";
import {
  decodeCorpusSearchCursor,
  encodeCorpusSearchCursor,
  isStaleCorpusSearchCursor,
} from "@/api/lib/legal-search/corpus-search-cursor";
import { loadFtsSearchConfigs } from "@/api/lib/legal-search/fts-config";
import {
  corpusIndexId,
  corpusIndexPattern,
  isCorpusIndexJurisdiction,
} from "@/api/lib/legal-search/index-naming";
import { NO_EXPANSION_DICTIONARY_IDENTITY } from "@/api/lib/legal-search/morphology/dictionary";
import { buildPgFtsSearchSql } from "@/api/lib/legal-search/pg-fts-query";
import {
  blendStableCitationAuthority,
  stableBlendUpperBound,
} from "@/api/lib/legal-search/rerank";
import type { ScoredCandidate } from "@/api/lib/legal-search/rerank";
import {
  legislationPublicReadDb,
  type LegislationReadDb,
} from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import { encodeCursor } from "@/api/lib/search/cursor";
import {
  escapeAndHighlight,
  TS_HEADLINE_CONFIG,
} from "@/api/lib/search/highlight";

/**
 * Legislation search. Same two-engine shape as case law (pg-fts default,
 * corpus index when LEGAL_SEARCH_PROVIDER=corpus-index) over the `legislation`
 * family, returning legislation-shaped hits (eli/status/effectiveDate).
 */

export const searchLegislationBodySchema = t.Object({
  query: t.String({ minLength: 1, maxLength: LIMITS.searchQueryMaxLength }),
  limit: t.Optional(tPaginationLimit(LIMITS.caseLawSearchPageSizeMax)),
  cursor: t.Optional(tPaginationCursor()),
  jurisdiction: t.Optional(t.String({ maxLength: 3 })),
  documentType: t.Optional(t.String({ maxLength: 128 })),
  status: t.Optional(t.String({ maxLength: 32 })),
  source: t.Optional(tSafeId("legislationSource")),
  language: t.Optional(t.String({ maxLength: 8 })),
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
});

export type SearchLegislationBody = Static<typeof searchLegislationBodySchema>;

type LegislationHit = {
  documentId: string;
  eli: string;
  title: string;
  country: string;
  language: string;
  documentType: string | null;
  status: string;
  effectiveDate: string | null;
  sourceUrl: string | null;
  headline: string | null;
  score: number;
};

type RawRow = Record<string, unknown>;

type SearchLegislationDependencies = {
  loadSearchConfigs: typeof loadFtsSearchConfigs;
};

const defaultSearchLegislationDependencies: SearchLegislationDependencies = {
  loadSearchConfigs: loadFtsSearchConfigs,
};

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

const headlineRegconfig = sql`'public.stella_unaccent'::regconfig`;

const pgSearch = async (
  body: SearchLegislationBody,
  parsedCursor: SearchCursor | null,
  legislationDb: LegislationReadDb,
  dependencies: SearchLegislationDependencies,
): Promise<{ hits: LegislationHit[]; nextCursor: string | null }> => {
  const limit = body.limit ?? LIMITS.caseLawSearchPageSizeDefault;
  const ftsSearch = buildPgFtsSearchSql({
    configs: await dependencies.loadSearchConfigs(),
    query: body.query,
    refs: {
      language: sql`sd.language`,
      regconfig: sql`sd.regconfig`,
      vector: sql`sd.tsv`,
    },
  });

  const filters = sql`
    ${body.jurisdiction ? sql`AND d.country = ${body.jurisdiction}` : sql``}
    ${body.documentType ? sql`AND d.document_type = ${body.documentType}` : sql``}
    ${body.status ? sql`AND d.status = ${body.status}` : sql``}
    ${body.source ? sql`AND d.source_id = ${body.source}` : sql``}
    ${body.language ? sql`AND d.language = ${body.language}` : sql``}
    ${body.dateFrom ? sql`AND d.effective_date >= ${body.dateFrom}` : sql``}
    ${body.dateTo ? sql`AND d.effective_date <= ${body.dateTo}` : sql``}
  `;

  // One fragment for the ORDER BY and the cursor predicate alike: keyset
  // pagination is only stable while the two are the same expression.
  const scoreExpr = blendedRankSql({
    authority: sql`d.citation_authority`,
    courtTier: noCourtTierSql(),
    lexicalRank: ftsSearch.rank,
  });
  const cursorFilter = parsedCursor
    ? sql`AND (${scoreExpr}, sd.document_id) < (${parsedCursor.score}::float8, ${parsedCursor.id})`
    : sql``;

  const rows = await legislationDb((tx) =>
    tx.execute(sql`
    SELECT
      sd.document_id,
      d.eli,
      d.title,
      d.country,
      d.language,
      d.document_type,
      d.status,
      d.effective_date,
      d.source_url,
      ts_headline(
        ${headlineRegconfig},
        left(
          coalesce(nullif(d.fulltext, ''), sd.searchable_text),
          ${LIMITS.searchHeadlineDocumentMaxChars}
        ),
        ${ftsSearch.headlineQuery},
        ${TS_HEADLINE_CONFIG}
      ) AS headline,
      ${scoreExpr} AS score
    FROM legislation_search_documents sd
    JOIN legislation_documents d ON d.id = sd.document_id
    JOIN legislation_sources
      ON legislation_sources.id = d.source_id
     AND ${redistributableLegislationSource}
    WHERE ${ftsSearch.predicate}
      AND sd.retry_after IS NULL
      ${filters}
      ${cursorFilter}
    ORDER BY score DESC, sd.document_id DESC
    LIMIT ${limit + 1}
  `),
  );

  const result: RawRow[] = rows;
  const hasMore = result.length > limit;
  const pageRows = hasMore ? result.slice(0, limit) : result;
  const lastRow = pageRows.at(-1);
  const nextCursor =
    hasMore && lastRow
      ? encodeCursor(Number(lastRow["score"]), String(lastRow["document_id"]))
      : null;

  const hits = pageRows.map((row) => mapRowHit(row));
  return { hits, nextCursor };
};

const mapRowHit = (row: RawRow): LegislationHit => {
  const headline = toNullableString(row["headline"]);
  return {
    documentId: String(row["document_id"]),
    eli: String(row["eli"]),
    title: String(row["title"]),
    country: String(row["country"]),
    language: String(row["language"]),
    documentType: toNullableString(row["document_type"]),
    status: String(row["status"]),
    effectiveDate: toNullableString(row["effective_date"]),
    sourceUrl: toNullableString(row["source_url"]),
    headline: headline ? escapeAndHighlight(headline) : null,
    score: Number(row["score"]) || 0,
  };
};

const buildCorpusIndexQuery = (body: SearchLegislationBody): string | null => {
  const freeText = corpusFreeTextClause(body.query);
  if (freeText === null) {
    return null;
  }
  const clauses = [freeText];
  if (body.documentType) {
    clauses.push(`document_type:${quoteCorpusValue(body.documentType)}`);
  }
  if (body.status) {
    clauses.push(`status:${quoteCorpusValue(body.status)}`);
  }
  if (body.source) {
    clauses.push(`source:${quoteCorpusValue(body.source)}`);
  }
  if (body.language) {
    clauses.push(`language:${quoteCorpusValue(body.language)}`);
  }
  if (body.dateFrom || body.dateTo) {
    clauses.push(
      `effective_date:[${body.dateFrom ?? "*"} TO ${body.dateTo ?? "*"}]`,
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

type RehydrateLegislationCandidatesOptions = {
  body: SearchLegislationBody;
  candidates: readonly ScoredCandidate[];
  legislationDb: LegislationReadDb;
};

/**
 * The production corpus-index rehydration query, exported so the reader-role
 * suite executes this exact query surface under SET ROLE.
 */
export const rehydrateLegislationCandidates = async ({
  body,
  candidates,
  legislationDb,
}: RehydrateLegislationCandidatesOptions) => {
  const ids = candidates.map((candidate) =>
    toSafeId<"legislationDocument">(candidate.id),
  );
  // Reapply the request filters against the current rows: a stale corpus hit
  // (metadata changed, async re-index/delete pending) must not satisfy filters
  // it no longer matches.
  const rehydrationFilters: SQL[] = [
    redistributableLegislationSource,
    // Accept only hits whose index state is current. The equality fails for
    // rows cleared for a write retry (null contentHash) and for rows whose
    // payload changed but are not re-indexed yet (indexedHash cleared by
    // ingestion), so stale index copies cannot serve outdated snippets.
    eq(legislationDocuments.indexedHash, legislationDocuments.contentHash),
  ];
  if (body.jurisdiction) {
    rehydrationFilters.push(
      eq(legislationDocuments.country, body.jurisdiction),
    );
  }
  if (body.documentType) {
    rehydrationFilters.push(
      eq(legislationDocuments.documentType, body.documentType),
    );
  }
  if (body.status) {
    rehydrationFilters.push(eq(legislationDocuments.status, body.status));
  }
  if (body.source) {
    rehydrationFilters.push(eq(legislationDocuments.sourceId, body.source));
  }
  if (body.language) {
    rehydrationFilters.push(eq(legislationDocuments.language, body.language));
  }
  if (body.dateFrom) {
    rehydrationFilters.push(
      sql`${legislationDocuments.effectiveDate} >= ${body.dateFrom}`,
    );
  }
  if (body.dateTo) {
    rehydrationFilters.push(
      sql`${legislationDocuments.effectiveDate} <= ${body.dateTo}`,
    );
  }
  const rows =
    ids.length === 0
      ? []
      : await legislationDb((tx) =>
          tx
            .select({
              id: legislationDocuments.id,
              eli: legislationDocuments.eli,
              title: legislationDocuments.title,
              country: legislationDocuments.country,
              language: legislationDocuments.language,
              documentType: legislationDocuments.documentType,
              statusValue: legislationDocuments.status,
              effectiveDate: legislationDocuments.effectiveDate,
              sourceUrl: legislationDocuments.sourceUrl,
              citationAuthority: legislationDocuments.citationAuthority,
            })
            .from(legislationDocuments)
            .innerJoin(
              legislationSources,
              eq(legislationSources.id, legislationDocuments.sourceId),
            )
            .where(
              and(inArray(legislationDocuments.id, ids), ...rehydrationFilters),
            ),
        );

  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const authorityById = new Map(
    rows.map((row) => [String(row.id), row.citationAuthority]),
  );

  return {
    context: { byId },
    ranked: blendStableCitationAuthority({
      candidates: candidates.filter((candidate) => byId.has(candidate.id)),
      authorityById,
    }),
  };
};

const corpusIndexSearch = async (
  body: SearchLegislationBody,
  parsedCursor: SearchCursor | null,
  legislationDb: LegislationReadDb,
): Promise<{ hits: LegislationHit[]; nextCursor: string | null }> => {
  const limit = body.limit ?? LIMITS.caseLawSearchPageSizeDefault;
  const serving = await legislationDb(
    async (tx) => await readServingCorpusIndexGenerationTx(tx, "legislation"),
  );
  const generation = serving.generation;
  const indexId = body.jurisdiction
    ? corpusIndexId(generation, body.jurisdiction)
    : corpusIndexPattern(generation);

  const query = buildCorpusIndexQuery(body);
  if (query === null) {
    return { hits: [], nextCursor: null };
  }

  const searchPage = await readCorpusIndexSearchPage({
    cluster: serving.cluster,
    indexId,
    query,
    limit,
    parsedCursor,
    snippetFields: ["text"],
    extractId: (hit) => {
      const id = hit["document_id"];
      return typeof id === "string" && isUuid(id) ? id : null;
    },
    extractSnippet: extractCorpusSnippet,
    // Upper bound for the pagination early-stop: scanning may end only once
    // no unseen candidate could out-blend the page cursor. Saturated
    // authority is bounded by 1, so the bound reads nothing from the corpus.
    unseenScoreUpperBound: stableBlendUpperBound,
    rankCandidates: async (candidates) =>
      await rehydrateLegislationCandidates({
        body,
        candidates,
        legislationDb,
      }),
  });

  const {
    context: { byId },
    pageRanked,
    snippetById,
  } = searchPage;
  // Legislation queries are never expanded, so the identity a legislation
  // page reports is always `none` — one wire format across both corpora, and
  // a cursor that crosses them is refused rather than misread.
  const nextCursor =
    searchPage.nextCursor === null
      ? null
      : encodeCorpusSearchCursor({
          ...searchPage.nextCursor,
          dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
        });

  const hits = pageRanked.flatMap((hit): LegislationHit[] => {
    const row = byId.get(hit.id);
    if (!row) {
      return [];
    }
    return [
      {
        documentId: row.id,
        eli: row.eli,
        title: row.title,
        country: row.country,
        language: row.language,
        documentType: toNullableString(row.documentType),
        status: row.statusValue,
        effectiveDate: toNullableString(row.effectiveDate),
        sourceUrl: toNullableString(row.sourceUrl),
        headline: snippetById.get(hit.id) ?? null,
        score: hit.score,
      },
    ];
  });

  return { hits, nextCursor };
};

export const searchLegislationHandler = async (
  body: SearchLegislationBody,
  legislationDb: LegislationReadDb,
  dependencies = defaultSearchLegislationDependencies,
) => {
  // source_id and the cursor id reach Postgres as UUID comparisons in the
  // pg-fts path; reject malformed values at the boundary so a bad filter
  // is a 400, not a 500 from an invalid-uuid cast.
  if (body.source !== undefined && !isUuid(body.source)) {
    return status(400, { message: "Invalid source" });
  }

  if (
    body.jurisdiction !== undefined &&
    !isCorpusIndexJurisdiction(body.jurisdiction)
  ) {
    return status(400, { message: "Invalid jurisdiction" });
  }

  // One rejection for every way a cursor can fail to name a page of this
  // corpus, checked before either search path reads anything. A cursor that
  // names a dictionary was issued by an expanded case-law search: legislation
  // is never expanded, so its score, id and window describe a ranking of
  // other documents entirely, and applying them here would page a legislation
  // result set from a case-law boundary.
  const parsedCursor = body.cursor
    ? decodeCorpusSearchCursor(body.cursor)
    : null;
  if (
    body.cursor !== undefined &&
    (parsedCursor === null ||
      !isUuid(parsedCursor.id) ||
      isStaleCorpusSearchCursor(parsedCursor, NO_EXPANSION_DICTIONARY_IDENTITY))
  ) {
    return status(400, { message: "Invalid cursor" });
  }

  const { hits, nextCursor } =
    envBase.LEGAL_SEARCH_PROVIDER === "corpus-index"
      ? await corpusIndexSearch(body, parsedCursor, legislationDb)
      : await pgSearch(body, parsedCursor, legislationDb, dependencies);

  return { hits, nextCursor, totalCount: null };
};

const config = {
  description:
    "Full-text search the stella legislation corpus, returning ranked hits " +
    "with a highlighted snippet and each document's ELI, title, country, " +
    "language, type, status, and effective date. Filter by jurisdiction, " +
    "document type, status, source, language, and effective-date range; " +
    "paginate with limit and cursor. Only sources cleared for redistribution " +
    "are searched. Read a hit in full with legislation.get; use " +
    "legislation.boe-search to query the Spanish BOE service directly " +
    "instead.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "legal_corpus_admin" },
  access: "read",
  body: searchLegislationBodySchema,
} satisfies HandlerConfig;

const searchLegislation = createSafeRootHandler(
  config,
  async function* ({ body }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await searchLegislationHandler(body, legislationPublicReadDb),
      ),
    );
    return Result.ok(response);
  },
);

export default searchLegislation;
