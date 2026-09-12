import { panic, Result } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status } from "elysia";
import type { Static } from "elysia";

import { publicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";
import {
  type DecisionQueryIntent,
  parseDecisionQuery,
} from "@stll/api-contract/decision-query-intent";
import {
  countedSearchTotal,
  SEARCH_TOTAL_NOT_COUNTED,
  SEARCH_TOTAL_TYPE,
  type SearchTotal,
} from "@stll/api-contract/search";
import { Temporal } from "@stll/time";

import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import {
  courtWeightSql,
  polarityWeightSql,
} from "@/api/handlers/case-law/citation-score";
import type { searchDecisionsBodySchema } from "@/api/handlers/case-law/decisions/search-schema";
import {
  CASE_LAW_SEARCH_DB_READ,
  createCaseLawSearchDbTimer,
  decisionQueryClass,
  reportCaseLawSearchCompleted,
} from "@/api/handlers/case-law/decisions/search-telemetry";
import { bareCitationKey } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { arrayOrEmpty } from "@/api/lib/array";
// eslint-disable-next-line no-restricted-imports -- search boundary: brands document ids returned by the corpus index before re-hydrating from Postgres
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import {
  courtTierSqlFromMap,
  courtWeightFromMap,
  flattenCourtWeightEntries,
  loadCourtWeights,
} from "@/api/lib/case-law/court-weights";
import type { CourtWeightMap } from "@/api/lib/case-law/court-weights";
import { decisionIdentifierProjection } from "@/api/lib/case-law/decision-identifiers";
import {
  decodeDecisionSearchCursor,
  type DecisionSearchCursor,
  encodeDecisionSearchCursor,
} from "@/api/lib/case-law/decision-search-cursor";
import type {
  DecisionSearchFacets,
  SearchFacetBucket,
} from "@/api/lib/case-law/decision-search-facets";
import {
  groupCourtsByTier,
  labelSourceBuckets,
  readCaseLawSourceNames,
} from "@/api/lib/case-law/decision-search-facets";
import {
  decisionDatedFilterSql,
  decisionSortKeySql,
} from "@/api/lib/case-law/decision-search-order-sql";
import { readDecisionHeadnote } from "@/api/lib/case-law/decision-text";
import { readPublicDecisionLanguageAlternatesByGroup } from "@/api/lib/case-law/language-alternates";
import { publisherSummaryMetadataSql } from "@/api/lib/case-law/publisher-summary";
import {
  redistributableCaseLawSource,
  redistributableCaseLawSourceSqlFor,
} from "@/api/lib/case-law/redistribution";
import {
  bodyPreviewJoin,
  redistributableSourceJoin,
} from "@/api/lib/case-law/search-sql";
import { isUuid } from "@/api/lib/custom-schema";
import { errorTag } from "@/api/lib/errors/utils";
import { decisionDocketGrammarForCountry } from "@/api/lib/legal-search/adapter-manifest";
import { blendedRankSql } from "@/api/lib/legal-search/authority-sql";
import { currentCaseLawCorpusProjection } from "@/api/lib/legal-search/case-law-corpus-projection";
import { withCaseLawDatedDecisions } from "@/api/lib/legal-search/case-law-dated-decisions";
import type { QuickwitCluster } from "@/api/lib/legal-search/corpus-generation-contract";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import { DECISION_TIMESTAMP_FIELD } from "@/api/lib/legal-search/corpus-index-config";
import { readServingCorpusIndexGenerationTx } from "@/api/lib/legal-search/corpus-index-generation-store";
import type { CorpusIndexScanReport } from "@/api/lib/legal-search/corpus-index-pagination";
import {
  emptyCorpusIndexScan,
  readCorpusIndexSearchPage,
} from "@/api/lib/legal-search/corpus-index-pagination";
import {
  caseLawCorpusQueryFields,
  type CaseLawCorpusQueryFields,
  requireCaseLawDecisionCountField,
} from "@/api/lib/legal-search/corpus-index-read-contract";
import {
  type CorpusFacetQuery,
  type CorpusSearchFacetName,
  readCorpusSearchFacets,
} from "@/api/lib/legal-search/corpus-index-search-facets";
import {
  caseLawCorpusQuery,
  type CorpusTermExpander,
} from "@/api/lib/legal-search/corpus-query";
import {
  type CorpusSearchCursor,
  decodeCorpusSearchCursor,
  encodeCorpusSearchCursor,
  isStaleCorpusSearchCursor,
} from "@/api/lib/legal-search/corpus-search-cursor";
import {
  type CorpusSearchOrder,
  DEFAULT_SEARCH_SORT,
  RELEVANCE_ORDER,
  type SearchSort,
} from "@/api/lib/legal-search/corpus-search-order";
import {
  type ExpandedCorpusQuery,
  resolveExpandedCorpusQuery,
} from "@/api/lib/legal-search/expansion";
import { loadFtsSearchConfigs } from "@/api/lib/legal-search/fts-config";
import {
  corpusIndexRoute,
  isCorpusIndexJurisdiction,
} from "@/api/lib/legal-search/index-naming";
import { collapseByLanguageGroup } from "@/api/lib/legal-search/language-group-collapse";
import { buildPgFtsSearchSql } from "@/api/lib/legal-search/pg-fts-query";
import {
  blendStableCitationAuthority,
  courtTierSignal,
  DEFAULT_AUTHORITY_WEIGHT,
  stableBlendUpperBound,
} from "@/api/lib/legal-search/rerank";
import type {
  BlendSignal,
  RankedHit,
  ScoredCandidate,
} from "@/api/lib/legal-search/rerank";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
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

/**
 * A facet statement's rows as buckets. Every one of them selects `value` and
 * `count` under those names, so one projection reads them all and a new facet
 * cannot invent a row shape.
 */
const facetBuckets = (
  rows: Record<string, unknown>[] | null | undefined,
): SearchFacetBucket[] =>
  arrayOrEmpty(rows).map((row) => ({
    value: String(row["value"]),
    label: null,
    count: Number(row["count"]),
  }));

type SearchDecisionsBody = Static<typeof searchDecisionsBodySchema>;

export const searchDecisionsHandler = async (
  body: SearchDecisionsBody,
  caseLawDb: CaseLawPublicReadDb,
) => {
  const country = publicCaseLawCountry(body.country);
  if (country === null) {
    return status(404, { message: "Not Found" });
  }
  const scopedBody = { ...body, country };
  if (envBase.LEGAL_SEARCH_PROVIDER === "corpus-index") {
    return await searchCorpusIndexDecisions(scopedBody, caseLawDb);
  }

  return await searchPostgresDecisions(scopedBody, caseLawDb);
};

const searchPostgresDecisions = async (
  body: SearchDecisionsBody,
  caseLawDb: CaseLawPublicReadDb,
) => {
  const limit = body.limit ?? LIMITS.caseLawSearchPageSizeDefault;
  const sort = body.sort ?? DEFAULT_SEARCH_SORT;

  // Validate cursor early so a tampered value fails visibly, and refuse one
  // that bounds a different order: its key is a position in that order.
  let parsedCursor: DecisionSearchCursor | null = null;
  if (body.cursor) {
    parsedCursor = decodeDecisionSearchCursor(body.cursor);
    if (parsedCursor === null || parsedCursor.sort !== sort) {
      return status(400, { message: "Invalid cursor" });
    }
  }

  const ftsSearch = buildPgFtsSearchSql({
    configs: await loadFtsSearchConfigs(),
    query: body.query,
    refs: {
      language: sql`sd.language`,
      regconfig: sql`sd.regconfig`,
      vector: sql`sd.tsv`,
    },
  });

  // Optional filters on the decisions table
  const courtFilter = body.court ? sql`AND d.court = ${body.court}` : sql``;
  const countryFilter = sql`AND d.country = ${body.country}`;
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

  // One registry for both places the statement reads it: the tier prior on the
  // decision itself, and the weight each incoming citation carries below.
  const courtWeights = await loadCourtWeights();
  const scoreExpr = blendedRankSql({
    authority: sql`cb.authority`,
    courtTier: sql.raw(
      courtTierSqlFromMap({
        countryColumn: "d.country",
        courtColumn: "d.court",
        map: courtWeights,
      }),
    ),
    lexicalRank: ftsSearch.rank,
  });
  const sortKeyExpr = decisionSortKeySql(sort, scoreExpr);
  // Never dropped by a facet's cross-filter: it is not one of the reader's
  // filters, it is what the requested order can rank, so a facet counting past
  // it would advertise decisions no page can reach.
  const datedFilter = decisionDatedFilterSql(sort);

  // The ORDER BY and the cursor predicate read the same materialized sort
  // column: keyset pagination is only stable while the two agree.
  const cursorFilter = parsedCursor
    ? sql`AND (m.sort_key, m.decision_id) < (
        ${parsedCursor.sortKey}::float8,
        ${parsedCursor.id}
      )`
    : sql``;

  const allFilters = sql`
    ${datedFilter}
    ${courtFilter}
    ${countryFilter}
    ${dateFromFilter}
    ${dateToFilter}
    ${typeFilter}
    ${sourceFilter}
    ${languageFilter}
  `;

  // The citing court can belong to any jurisdiction — citation graphs cross
  // borders — so this side of the statement reads the flattened registry
  // rather than the decision's own country.
  const courtWeightExpr = courtWeightSql(
    "citing_d.court",
    flattenCourtWeightEntries(courtWeights),
  );

  const citationAuthorityLateral = sql.raw(`
    LATERAL (
      SELECT ln(1 + coalesce(
        sum(
          (${polarityWeightSql("c.polarity")})
          * (${courtWeightExpr})
          * (1.0 / (1 + COALESCE(extract(epoch FROM (now() - citing_d.decision_date)) / (365.25 * 86400), 1.0)))
        ),
        0
      )) AS authority,
      count(*)::int AS cnt
      FROM case_law_citations c
      JOIN case_law_decisions citing_d
        ON citing_d.id = c.citing_decision_id
      JOIN case_law_sources citing_src
        ON citing_src.id = citing_d.source_id
       AND ${redistributableCaseLawSourceSqlFor("citing_src")}
      WHERE c.cited_decision_id = d.id
    ) cb
  `);

  // Every matched language version, scored once. The page and the total both
  // read this set, so the representative rule below sees exactly what the
  // page does.
  const matchedCte = sql`
    matched AS (
      SELECT
        sd.decision_id,
        d.language_group_key,
        ${sortKeyExpr} AS sort_key,
        cb.cnt AS citation_count
      FROM case_law_search_documents sd
      JOIN case_law_decisions d
        ON d.id = sd.decision_id
      ${redistributableSourceJoin}
      LEFT JOIN ${citationAuthorityLateral} ON true
      WHERE ${ftsSearch.predicate}
        ${allFilters}
    )
  `;

  // A judgment matched in several languages is one result. Its representative
  // is its first matched version in the request's order, id as the tie-break:
  // a property of the row and the query, not of the page, so the keyset cursor
  // stays valid across pages.
  const representativeFilter = sql`
    (
      m.language_group_key IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM matched sibling
        WHERE sibling.language_group_key = m.language_group_key
          AND (sibling.sort_key, sibling.decision_id)
            > (m.sort_key, m.decision_id)
      )
    )
  `;

  const hitsQuery = sql`
    WITH ${matchedCte}
    SELECT
      m.decision_id,
      d.case_number,
      d.slug,
      d.ecli,
      (
        SELECT coalesce(
          jsonb_agg(
            jsonb_build_object('type', identifier.type, 'value', identifier.value)
            ORDER BY identifier.type, identifier.value
          ),
          '[]'::jsonb
        )
        FROM case_law_decision_identifiers identifier
        WHERE identifier.decision_id = d.id
      ) AS identifiers,
      d.court,
      d.country,
      d.language,
      d.language_group_key,
      d.decision_date,
      d.decision_type,
      d.source_url,
      ${publisherSummaryMetadataSql(sql.raw("d.metadata"))} AS headnote,
      ts_headline(
        ${headlineRegconfig},
        left(
          coalesce(nullif(body_preview.text, ''), d.fulltext, sd.searchable_text),
          ${LIMITS.searchHeadlineDocumentMaxChars}
        ),
        ${ftsSearch.headlineQuery},
        ${TS_HEADLINE_CONFIG}
      ) AS headline,
      m.sort_key,
      m.citation_count,
      d.created_at
    FROM matched m
    JOIN case_law_decisions d
      ON d.id = m.decision_id
    JOIN case_law_search_documents sd
      ON sd.decision_id = m.decision_id
    ${bodyPreviewJoin}
    WHERE ${representativeFilter}
      ${cursorFilter}
    ORDER BY m.sort_key DESC, m.decision_id DESC
    LIMIT ${limit + 1}
  `;

  const countQuery = sql`
    WITH ${matchedCte}
    SELECT count(*)::int AS total
    FROM matched m
    WHERE ${representativeFilter}
  `;

  // Facets count judgments, not language versions: a multilingual decision
  // contributes one to its court however many versions matched. The language
  // facet is per version by definition, and a version is itself a decision.
  const judgmentCountSql = sql`
    count(distinct coalesce(d.language_group_key, sd.decision_id::text))::int
  `;

  // Every facet is cross-filtered: it applies the request's other filters and
  // omits its own, so narrowing inside one facet never empties it.
  const facetFrom = sql`
    FROM case_law_search_documents sd
    JOIN case_law_decisions d
      ON d.id = sd.decision_id
    ${redistributableSourceJoin}
  `;

  const courtFacetQuery = sql`
    SELECT d.court AS value, ${judgmentCountSql} AS count
    ${facetFrom}
    WHERE ${ftsSearch.predicate}
      ${datedFilter}
      ${countryFilter}
      ${dateFromFilter}
      ${dateToFilter}
      ${typeFilter}
      ${sourceFilter}
      ${languageFilter}
    GROUP BY d.court
    ORDER BY count DESC
    LIMIT ${LIMITS.caseLawCourtFacetBuckets}
  `;

  // The year facet's own filter is the date range, so this one drops it.
  // Undated decisions have no year to offer and are left out of the buckets.
  const yearFacetQuery = sql`
    SELECT extract(year FROM d.decision_date)::int AS value,
           ${judgmentCountSql} AS count
    ${facetFrom}
    WHERE ${ftsSearch.predicate}
      ${courtFilter}
      ${countryFilter}
      ${typeFilter}
      ${sourceFilter}
      ${languageFilter}
      AND d.decision_date IS NOT NULL
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT ${LIMITS.caseLawYearFacetLimit}
  `;

  const decisionTypeFacetQuery = sql`
    SELECT d.decision_type AS value, ${judgmentCountSql} AS count
    ${facetFrom}
    WHERE ${ftsSearch.predicate}
      ${datedFilter}
      ${courtFilter}
      ${countryFilter}
      ${dateFromFilter}
      ${dateToFilter}
      ${sourceFilter}
      ${languageFilter}
      AND d.decision_type IS NOT NULL
    GROUP BY d.decision_type
    ORDER BY count DESC
    LIMIT ${LIMITS.caseLawFacetLimit}
  `;

  const sourceFacetQuery = sql`
    SELECT d.source_id::text AS value, ${judgmentCountSql} AS count
    ${facetFrom}
    WHERE ${ftsSearch.predicate}
      ${datedFilter}
      ${courtFilter}
      ${countryFilter}
      ${dateFromFilter}
      ${dateToFilter}
      ${typeFilter}
      ${languageFilter}
    GROUP BY d.source_id
    ORDER BY count DESC
    LIMIT ${LIMITS.caseLawFacetLimit}
  `;

  const languageFacetQuery = sql`
    SELECT d.language AS value, count(distinct sd.decision_id)::int AS count
    ${facetFrom}
    WHERE ${ftsSearch.predicate}
      ${datedFilter}
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
  const onFirstPage = (query: SQL): Promise<RawRows> =>
    parsedCursor ? emptyRows : caseLawDb((tx) => tx.execute(query));

  // Skip the expensive COUNT(*) and the facet queries on paginated requests;
  // these values describe the result set, not the page.
  const [
    hitsResultRaw,
    countResultRaw,
    courtResultRaw,
    yearResultRaw,
    decisionTypeResultRaw,
    sourceResultRaw,
    languageResultRaw,
  ] = await Promise.all([
    caseLawDb((tx) => tx.execute(hitsQuery)),
    onFirstPage(countQuery),
    onFirstPage(courtFacetQuery),
    onFirstPage(yearFacetQuery),
    onFirstPage(decisionTypeFacetQuery),
    onFirstPage(sourceFacetQuery),
    onFirstPage(languageFacetQuery),
  ]);

  const hitsResult = arrayOrEmpty(hitsResultRaw);
  const countResult = arrayOrEmpty(countResultRaw);

  const hasMore = hitsResult.length > limit;
  const resultRows = hasMore ? hitsResult.slice(0, limit) : hitsResult;
  const languageGroupKeys = [
    ...new Set(
      resultRows
        .map((row) => toNullableString(row["language_group_key"]))
        .filter((value): value is string => value !== null),
    ),
  ];
  const alternatesByGroupKey =
    await readPublicDecisionLanguageAlternatesByGroup({
      caseLawDb,
      languageGroupKeys,
    });

  const lastRaw = resultRows.at(-1);
  const nextCursor =
    hasMore && lastRaw
      ? encodeDecisionSearchCursor({
          id: String(lastRaw["decision_id"]),
          sort,
          sortKey: Number(lastRaw["sort_key"]),
        })
      : null;

  const hits = resultRows.map((row) => {
    const languageGroupKey = toNullableString(row["language_group_key"]);
    const headline = toNullableString(row["headline"]);

    return {
      decisionId: String(row["decision_id"]),
      caseNumber: String(row["case_number"]),
      slug: toNullableString(row["slug"]),
      ecli: toNullableString(row["ecli"]),
      identifiers: decisionIdentifierProjection(row["identifiers"], {
        caseNumber: String(row["case_number"]),
        ecli: toNullableString(row["ecli"]),
      }),
      court: String(row["court"]),
      country: String(row["country"]),
      language: String(row["language"]),
      languageAlternates: alternatesByGroupKey.alternatesFor(languageGroupKey),
      decisionDate: toNullableString(row["decision_date"]),
      decisionType: toNullableString(row["decision_type"]),
      sourceUrl: toNullableString(row["source_url"]),
      headnote: readDecisionHeadnote(row["headnote"]),
      headline: headline ? escapeAndHighlight(headline) : null,
      // Postgres FTS scores whole decisions, so there is no passage to anchor
      // the hit to. Kept on both paths so the response shape does not depend
      // on which provider served it.
      anchorId: null,
      citationCount: Number(row["citation_count"]) || 0,
      createdAt:
        row["created_at"] instanceof Date
          ? row["created_at"].toISOString()
          : String(row["created_at"]),
    };
  });

  const total = parsedCursor
    ? SEARCH_TOTAL_NOT_COUNTED
    : countedSearchTotal(
        SEARCH_TOTAL_TYPE.EXACT,
        Number(countResult.at(0)?.["total"]) || 0,
      );

  const sourceBuckets = facetBuckets(sourceResultRaw);
  const facets: DecisionSearchFacets | null = parsedCursor
    ? null
    : {
        court: groupCourtsByTier({
          buckets: facetBuckets(courtResultRaw),
          country: body.country,
          courtWeights,
          perTierLimit: LIMITS.caseLawFacetLimit,
        }),
        // Already newest-first from the statement; the year is the key it
        // grouped and ordered by.
        year: facetBuckets(yearResultRaw),
        decisionType: facetBuckets(decisionTypeResultRaw),
        source: labelSourceBuckets(
          sourceBuckets,
          await readCaseLawSourceNames(
            caseLawDb,
            sourceBuckets.map((bucket) => bucket.value),
          ),
        ),
        language: facetBuckets(languageResultRaw),
      };

  return {
    hits,
    facets,
    total,
    nextCursor,
  };
};

// `country` is deliberately absent from the filters: it selects the index,
// not a clause. It does select the expansion dictionary and the stemming
// language, which is why both are resolved from it here rather than inside
// the query builder.
type CorpusIndexQueryOptions = {
  body: SearchDecisionsBody;
  jurisdictionClause: string | undefined;
  fields: CaseLawCorpusQueryFields;
  expand?: CorpusTermExpander | undefined;
};

const buildCorpusIndexQuery = ({
  body,
  jurisdictionClause,
  fields,
  expand,
}: CorpusIndexQueryOptions): string | null =>
  caseLawCorpusQuery({
    text: body.query,
    filters: {
      court: body.court,
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
      documentType: body.decisionType,
      jurisdiction: jurisdictionClause,
      language: body.language,
      source: body.sourceId,
    },
    expand,
    stemming: fields.stemming,
    surfaceFields: fields.surfaceFields,
    keywordFields: fields.keywordFields,
  });

/**
 * The request as a facet counts across it: its own filter dropped, everything
 * else kept. A switch rather than a facet-to-field map, so a facet added
 * without an answer here does not compile.
 */
const bodyWithoutFacetFilter = (
  body: SearchDecisionsBody,
  facet: CorpusSearchFacetName,
): SearchDecisionsBody => {
  switch (facet) {
    case "court":
      return { ...body, court: undefined };
    case "decisionType":
      return { ...body, decisionType: undefined };
    case "source":
      return { ...body, sourceId: undefined };
    case "language":
      return { ...body, language: undefined };
    case "year":
      // The year facet's own filter is the date range the request carries.
      return { ...body, dateFrom: undefined, dateTo: undefined };
    default:
      facet satisfies never;
      return panic(`Unhandled search facet: ${String(facet)}`);
  }
};

type ResolveCorpusIndexQueryOptions = {
  body: SearchDecisionsBody;
  generation: string;
  jurisdictionClause: string | undefined;
};

type ResolvedCorpusIndexQuery = {
  resolved: ExpandedCorpusQuery;
  /**
   * The same query with one facet's own filter left out, built with whichever
   * expansion the resolver executed. A facet counted under a query built from
   * a different dictionary — or with a different stemming language, which the
   * `language` filter also selects — would describe a different result set
   * than the page it sits beside.
   */
  facetQueries: () => CorpusFacetQuery | null;
};

/** Mode, dictionary, and shadow accounting are the shared resolver's. */
const resolveCorpusIndexQuery = async ({
  body,
  generation,
  jurisdictionClause,
}: ResolveCorpusIndexQueryOptions): Promise<ResolvedCorpusIndexQuery> => {
  const sort = body.sort ?? DEFAULT_SEARCH_SORT;
  const fields = caseLawCorpusQueryFields({
    generation,
    jurisdiction: body.country,
    language: body.language,
  });
  // Which expander produced the query the resolver chose is not something the
  // resolver reports, and rebuilding a facet query with the wrong one would
  // count a different result set. Recording it per built query and looking the
  // executed one up answers it exactly.
  const expanderByQuery = new Map<string, CorpusTermExpander | undefined>();
  const resolved = await resolveExpandedCorpusQuery({
    build: (expand) => {
      const query = buildCorpusIndexQuery({
        body,
        jurisdictionClause,
        fields,
        expand,
      });
      if (query !== null) {
        expanderByQuery.set(query, expand);
      }
      return query;
    },
    jurisdiction: body.country,
    mode: envBase.QUERY_EXPANSION_MODE,
    text: body.query,
  });

  const facetQueries = (): CorpusFacetQuery | null => {
    if (resolved.type === "empty") {
      return null;
    }
    if (!expanderByQuery.has(resolved.query)) {
      return panic(
        "The resolved corpus query was not one this request built; a facet cannot be counted against it",
      );
    }
    const expand = expanderByQuery.get(resolved.query);
    return (facet) =>
      withCaseLawDatedDecisions(
        buildCorpusIndexQuery({
          body: bodyWithoutFacetFilter(body, facet),
          jurisdictionClause,
          fields,
          expand,
        }) ??
          // Dropping a filter only ever widens the query. What can build to
          // nothing is the reader's text, and it did not, or the resolver
          // would have answered `empty` above.
          panic(
            `The ${facet} facet query built to nothing while the search did not`,
          ),
        sort,
      );
  };

  return { resolved, facetQueries };
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

type DecisionRowsQueryOptions = {
  filters: SQL[];
  generation: string;
  ids: SafeId<"caseLawDecision">[];
};

/**
 * What blending a candidate needs, and nothing else. A request reads this for
 * every candidate the scan reaches — a few hundred of them — so every column
 * here is paid for a couple of hundred times to serve a page of ten. The
 * authority and the deciding court drive the blend, the group key folds the
 * language versions of one judgment, and the request's filters are applied in
 * SQL rather than read back.
 */
const candidateDecisionRowsQuery = (
  tx: CaseLawPublicReadTransaction,
  { filters, ids }: DecisionRowsQueryOptions,
) =>
  tx
    .select({
      id: caseLawDecisions.id,
      citationAuthority: caseLawDecisions.citationAuthority,
      // The court's rank is a blend signal; the country scopes the pattern
      // match that resolves it, since court names repeat across borders.
      court: caseLawDecisions.court,
      country: caseLawDecisions.country,
      languageGroupKey: caseLawDecisions.languageGroupKey,
    })
    .from(caseLawDecisions)
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(and(inArray(caseLawDecisions.id, ids), ...filters));

type CandidateDecisionRow = Awaited<
  ReturnType<typeof candidateDecisionRowsQuery>
>[number];

/**
 * Everything a result card shows, read only for the ids the page emits. The
 * publisher summary and the identifier aggregate are the expensive parts, and
 * a page of ten is the only place they are wanted.
 */
const pageDecisionRowsQuery = (
  tx: CaseLawPublicReadTransaction,
  { filters, ids }: DecisionRowsQueryOptions,
) =>
  tx
    .select({
      id: caseLawDecisions.id,
      caseNumber: caseLawDecisions.caseNumber,
      slug: caseLawDecisions.slug,
      ecli: caseLawDecisions.ecli,
      identifiers: sql<unknown>`coalesce((
        SELECT jsonb_agg(
          jsonb_build_object(
            'type', identifier.type,
            'value', identifier.value
          )
          ORDER BY identifier.type, identifier.value
        )
        FROM ${caseLawDecisionIdentifiers} identifier
        WHERE identifier.decision_id = ${caseLawDecisions.id}
      ), '[]'::jsonb)`,
      court: caseLawDecisions.court,
      country: caseLawDecisions.country,
      language: caseLawDecisions.language,
      languageGroupKey: caseLawDecisions.languageGroupKey,
      decisionDate: caseLawDecisions.decisionDate,
      decisionType: caseLawDecisions.decisionType,
      sourceUrl: caseLawDecisions.sourceUrl,
      headnote: publisherSummaryMetadataSql(caseLawDecisions.metadata),
      citationCount: caseLawDecisions.citationCount,
      createdAt: caseLawDecisions.createdAt,
    })
    .from(caseLawDecisions)
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(and(inArray(caseLawDecisions.id, ids), ...filters));

type PageDecisionRow = Awaited<
  ReturnType<typeof pageDecisionRowsQuery>
>[number];

/**
 * What one request has read so far: a row, or null for an id the current
 * rows no longer answer for (filtered out, scrubbed, pending). A scan ranks
 * everything it has accumulated after every round, so without this record
 * each round re-reads what the earlier rounds read, and the request's
 * database work grows with the square of the rounds.
 */
type HydratedDecisionRows = Map<string, CandidateDecisionRow | null>;

/**
 * Reapply the request filters against the current rows: a stale corpus hit
 * (metadata changed, async re-index/delete pending) must not satisfy filters
 * it no longer matches. Both reads apply them, so the page read that actually
 * emits publisher text re-proves the row is still servable rather than
 * inheriting the candidate read's answer.
 */
const caseLawSearchRowFilters = (
  body: SearchDecisionsBody,
  generation: string,
): SQL[] => {
  const filters: SQL[] = [
    redistributableCaseLawSource,
    // The generation's projection state rejects a scrubbed or pending row, so
    // a stale physical copy cannot serve outdated or erased snippets.
    currentCaseLawCorpusProjection(generation),
  ];
  if (body.court) {
    filters.push(eq(caseLawDecisions.court, body.court));
  }
  filters.push(eq(caseLawDecisions.country, body.country));
  if (body.dateFrom) {
    filters.push(sql`${caseLawDecisions.decisionDate} >= ${body.dateFrom}`);
  }
  if (body.dateTo) {
    filters.push(sql`${caseLawDecisions.decisionDate} <= ${body.dateTo}`);
  }
  if (body.decisionType) {
    filters.push(eq(caseLawDecisions.decisionType, body.decisionType));
  }
  if (body.sourceId) {
    filters.push(eq(caseLawDecisions.sourceId, body.sourceId));
  }
  if (body.language) {
    filters.push(eq(caseLawDecisions.language, body.language));
  }
  return filters;
};

/**
 * Brackets the database call a read makes, so a caller measuring Postgres
 * time measures the wait and not the work around it. Absent wherever nothing
 * is being measured.
 */
type TimeDbRead = <TRead>(run: () => Promise<TRead>) => Promise<TRead>;

const untimedDbRead: TimeDbRead = async (run) => await run();

type ReadCaseLawPageDecisionRowsOptions = {
  body: SearchDecisionsBody;
  caseLawDb: CaseLawPublicReadDb;
  generation: string;
  /** The ids the page emits, after ranking and the language-group fold. */
  ids: readonly string[];
  timeDbRead?: TimeDbRead | undefined;
};

/**
 * The wide read, for one page. Kept independently callable for the same
 * reason the candidate read is: the restricted-role census executes the exact
 * production projection without a live search engine.
 */
export const readCaseLawPageDecisionRows = async ({
  body,
  caseLawDb,
  generation,
  ids,
  timeDbRead = untimedDbRead,
}: ReadCaseLawPageDecisionRowsOptions): Promise<
  Map<string, PageDecisionRow>
> => {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await timeDbRead(
    async () =>
      await caseLawDb((tx) =>
        pageDecisionRowsQuery(tx, {
          filters: caseLawSearchRowFilters(body, generation),
          generation,
          ids: ids.map((id) => toSafeId<"caseLawDecision">(id)),
        }),
      ),
  );
  return new Map(rows.map((row) => [String(row.id), row]));
};

type RehydrateCaseLawCandidatesOptions = {
  body: SearchDecisionsBody;
  candidates: readonly ScoredCandidate[];
  caseLawDb: CaseLawPublicReadDb;
  /**
   * The court rank registry, read once for the request. Every court a
   * jurisdiction ranks is in it; an empty map ranks every court at the
   * default tier, which contributes nothing to the blend.
   */
  courtWeights: CourtWeightMap;
  generation: string;
  /** The request's record of rows read so far; only ids absent from it are read. */
  hydrated?: HydratedDecisionRows | undefined;
  timeDbRead?: TimeDbRead | undefined;
};

/**
 * The signals case-law search blends on top of the lexical score, beyond the
 * citation authority every stable blend already carries. The ranking and the
 * pagination early-stop bound are both built from this list, so a signal
 * cannot widen one without widening the other.
 */
const caseLawBlendSignals = (
  courtTierById: ReadonlyMap<string, number>,
): BlendSignal[] => [courtTierSignal(courtTierById)];

/**
 * Everything the blend can add on top of the lexical score: the citation
 * authority every stable blend carries, plus this search's own signals.
 * Summed from that same list, so a signal cannot widen the blend without
 * widening the bound. It reads the weights alone, never the values.
 */
const caseLawBlendWeight = (): number =>
  caseLawBlendSignals(new Map()).reduce(
    (total, signal) => total + signal.weight,
    DEFAULT_AUTHORITY_WEIGHT,
  );

/**
 * Upper bound for the pagination early-stop: scanning may end only once no
 * unseen candidate could out-blend the page cursor. Every signal saturates
 * below 1, so the summed weight is the whole of it and the bound reads
 * nothing from the corpus. Under `newest` nothing is added to the engine's
 * order at all, so the next rank's own position score is the bound — which is
 * what lets a date-ordered page stop at the round that fills it.
 */
const caseLawUnseenScoreUpperBound =
  (sort: SearchSort) =>
  (nextPositionScore: number): number => {
    switch (sort) {
      case "relevance":
        return stableBlendUpperBound(nextPositionScore, caseLawBlendWeight());
      case "newest":
        return nextPositionScore;
      default:
        sort satisfies never;
        return panic(`Unhandled search sort: ${String(sort)}`);
    }
  };

type RankCaseLawCandidatesOptions = {
  authorityById: ReadonlyMap<string, number>;
  candidates: readonly ScoredCandidate[];
  courtTierById: ReadonlyMap<string, number>;
  sort: SearchSort;
};

/**
 * The order a page is cut from. Relevance blends the engine's lexical order
 * with the corpus signals; `newest` does not blend at all — the engine already
 * returned the decisions in date order and the scan appended them in it, each
 * with a strictly decreasing position score, so that order IS the ranking and
 * anything added to it would be a different one than the reader asked for.
 */
const rankCaseLawCandidates = ({
  authorityById,
  candidates,
  courtTierById,
  sort,
}: RankCaseLawCandidatesOptions): RankedHit[] => {
  switch (sort) {
    case "relevance":
      return blendStableCitationAuthority({
        candidates,
        authorityById,
        signals: caseLawBlendSignals(courtTierById),
      });
    case "newest":
      return candidates.map((candidate) => ({
        id: candidate.id,
        score: candidate.score,
        lexicalScore: candidate.score,
        citationAuthority: authorityById.get(candidate.id) ?? 0,
      }));
    default:
      sort satisfies never;
      return panic(`Unhandled search sort: ${String(sort)}`);
  }
};

/**
 * The PostgreSQL half of corpus-index search. Keeping it independently
 * callable lets the restricted-role census execute the exact production
 * projection without needing a live search engine.
 */
export const rehydrateCaseLawCandidates = async ({
  body,
  candidates,
  caseLawDb,
  courtWeights,
  generation,
  hydrated = new Map(),
  timeDbRead = untimedDbRead,
}: RehydrateCaseLawCandidatesOptions) => {
  const ids = candidates
    .filter((candidate) => !hydrated.has(candidate.id))
    .map((candidate) => toSafeId<"caseLawDecision">(candidate.id));
  const rows =
    ids.length === 0
      ? []
      : await timeDbRead(
          async () =>
            await caseLawDb((tx) =>
              candidateDecisionRowsQuery(tx, {
                filters: caseLawSearchRowFilters(body, generation),
                generation,
                ids,
              }),
            ),
        );
  for (const id of ids) {
    hydrated.set(id, null);
  }
  for (const row of rows) {
    hydrated.set(String(row.id), row);
  }

  const byId = new Map<string, CandidateDecisionRow>();
  for (const [id, row] of hydrated) {
    if (row !== null) {
      byId.set(id, row);
    }
  }
  const authorityById = new Map<string, number>();
  // The court a decision comes from is known the day it is published, which
  // is what citation authority cannot say about a judgment nothing cites yet.
  // Resolved here rather than read from the index because the registry is a
  // per-jurisdiction pattern table an operator can revise without a rebuild.
  const courtTierById = new Map<string, number>();
  for (const [id, row] of byId) {
    authorityById.set(id, row.citationAuthority);
    courtTierById.set(
      id,
      courtWeightFromMap(courtWeights, row.court, row.country).tier,
    );
  }

  // Candidates missing from Postgres (index/DB drift) are dropped. Every
  // version is blended before the fold, so a version whose citation authority
  // lifts it past a lexically stronger sibling still stands for the judgment;
  // the versions of one decision then fold into their best-blended member. The
  // scan's early-stop bound guarantees no unseen version could out-blend an
  // emitted page, so the representative is the same on every rescan.
  const ranked = rankCaseLawCandidates({
    authorityById,
    candidates: candidates.filter((candidate) => byId.has(candidate.id)),
    courtTierById,
    sort: body.sort ?? DEFAULT_SEARCH_SORT,
  });
  const { representatives } = collapseByLanguageGroup(
    ranked,
    (hitId) => byId.get(hitId)?.languageGroupKey ?? null,
  );

  // No context travels with the ranking: what a page displays is read once
  // the page is decided, for its ids only, so nothing the blend read has to
  // be carried through the scan.
  return { context: null, ranked: representatives };
};

type DecisionIdentity = Extract<DecisionQueryIntent, { type: "identifier" }>;

/**
 * The decisions an entry names outright. A docket or an ECLI tokenises into
 * numbers and abbreviations the text index matches loosely (a plenary docket
 * ranks every plenary decision sharing a number with it), so an identifier
 * is answered from the identity columns instead: the canonical citation key
 * the citator resolves by, and the ECLI as published. Bounded by the page
 * size: past that the entry names a list, not a decision.
 */
type FindDecisionIdsByIdentityOptions = {
  caseLawDb: CaseLawPublicReadDb;
  country: string | undefined;
  identity: DecisionIdentity;
  timeDbRead?: TimeDbRead | undefined;
};

export const findDecisionIdsByIdentity = async ({
  caseLawDb,
  country,
  identity,
  timeDbRead = untimedDbRead,
}: FindDecisionIdsByIdentityOptions): Promise<SafeId<"caseLawDecision">[]> => {
  const identityPredicate =
    identity.kind === "ecli"
      ? inArray(caseLawDecisions.ecli, [
          identity.value,
          identity.value.toUpperCase(),
        ])
      : eq(caseLawDecisions.citationKey, bareCitationKey(identity.value));
  const rows = await timeDbRead(
    async () =>
      await caseLawDb((tx) =>
        tx
          .select({ id: caseLawDecisions.id })
          .from(caseLawDecisions)
          .where(
            and(
              identityPredicate,
              country === undefined
                ? undefined
                : eq(caseLawDecisions.country, country),
            ),
          )
          .limit(LIMITS.caseLawSearchPageSizeMax),
      ),
  );
  return rows.map((row) => row.id);
};

/** The language groups a page spans, for the alternates read. */
const languageGroupKeysOf = (
  pageRanked: readonly RankedHit[],
  byId: ReadonlyMap<string, { languageGroupKey: string | null }>,
): string[] => [
  ...new Set(
    pageRanked
      .map((hit) => byId.get(hit.id)?.languageGroupKey ?? null)
      .filter((value): value is string => value !== null),
  ),
];

type DecisionHitsPageOptions = {
  alternatesByGroupKey: Awaited<
    ReturnType<typeof readPublicDecisionLanguageAlternatesByGroup>
  >;
  anchorIdById: ReadonlyMap<string, string>;
  byId: ReadonlyMap<string, PageDecisionRow>;
  facets: DecisionSearchFacets | null;
  nextCursor: string | null;
  pageRanked: readonly RankedHit[];
  snippetById: ReadonlyMap<string, string>;
  total: SearchTotal;
};

/** One page of ranked, hydrated decisions in the search response shape. */
const decisionHitsPage = ({
  alternatesByGroupKey,
  anchorIdById,
  byId,
  facets,
  nextCursor,
  pageRanked,
  snippetById,
  total,
}: DecisionHitsPageOptions) => {
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
        identifiers: decisionIdentifierProjection(row.identifiers, {
          caseNumber: row.caseNumber,
          ecli: row.ecli,
        }),
        court: row.court,
        country: row.country,
        language: row.language,
        languageAlternates: alternatesByGroupKey.alternatesFor(
          row.languageGroupKey,
        ),
        decisionDate: row.decisionDate,
        decisionType: row.decisionType,
        sourceUrl: row.sourceUrl,
        headnote: readDecisionHeadnote(row.headnote),
        headline: snippetById.get(hit.id) ?? null,
        // Additive: the anchor of the passage the snippet came from, so a
        // result can open the decision scrolled to what matched. Null on a
        // document-granular generation, on unanchored fallback passages, and
        // on a decision the entry named outright.
        anchorId: anchorIdById.get(hit.id) ?? null,
        citationCount: row.citationCount,
        createdAt: row.createdAt.toISOString(),
      },
    ];
  });

  return {
    hits,
    facets,
    total,
    nextCursor,
  };
};

/** The engine order a request's sort asks the scan for. */
const corpusSearchOrder = (sort: SearchSort): CorpusSearchOrder => {
  switch (sort) {
    case "relevance":
      return RELEVANCE_ORDER;
    case "newest":
      // The generation's own timestamp field, not `decision_date`: the engine
      // requires the timestamp on every document, so it is the only date every
      // passage carries and the only one a total order can be taken over.
      return { type: "newest", timestampField: DECISION_TIMESTAMP_FIELD };
    default:
      sort satisfies never;
      return panic(`Unhandled search sort: ${String(sort)}`);
  }
};

type ReadCaseLawSearchFacetsOptions = {
  body: SearchDecisionsBody;
  caseLawDb: CaseLawPublicReadDb;
  cluster: QuickwitCluster;
  courtWeights: CourtWeightMap;
  /** The generation's document-id field, already asserted aggregatable. */
  decisionCountField: string;
  indexId: string;
  /** Null when the request has no query the facets could be counted under. */
  queryFor: CorpusFacetQuery | null;
  totalQuery: string;
};

type CaseLawSearchFacetsRead = {
  facets: DecisionSearchFacets;
  total: SearchTotal;
};

/**
 * The corpus-index branch's filter rail and result total, or null when the
 * engine could not answer for them. Both come from the same aggregations: the
 * total is the cardinality of the decision id over the whole query, which is
 * an estimate — the engine counts distinct values from a sketch — and every
 * bucket's count is that cardinality within the bucket.
 *
 * Facets are navigation, not the page's content, so a failed aggregation
 * degrades to a page with no filter rail and an uncounted total rather than
 * to an error a reader sees instead of their results.
 */
const readCaseLawSearchFacets = async ({
  body,
  caseLawDb,
  cluster,
  courtWeights,
  decisionCountField,
  indexId,
  queryFor,
  totalQuery,
}: ReadCaseLawSearchFacetsOptions): Promise<CaseLawSearchFacetsRead | null> => {
  if (queryFor === null) {
    return null;
  }
  const read = await readCorpusSearchFacets({
    aggregate: async (input) =>
      await getCorpusIndexClient(cluster).aggregate({ indexId, ...input }),
    // The year buckets run to one year past this one, so a decision a
    // publisher dated ahead still lands in a bucket of its own.
    currentYear: Temporal.Now.instant().toZonedDateTimeISO("UTC").year,
    decisionCountField,
    queryFor,
    totalQuery,
  });
  if (Result.isError(read)) {
    logger.warn("case_law.search_facets.unavailable", {
      "error.type": errorTag(read.error),
    });
    return null;
  }

  const { court, decisionType, language, source, year } = read.value.facets;
  const sourceNames = await readCaseLawSourceNames(
    caseLawDb,
    source.map((bucket) => bucket.value),
  );
  return {
    facets: {
      court: groupCourtsByTier({
        buckets: court,
        country: body.country,
        courtWeights,
        perTierLimit: LIMITS.caseLawFacetLimit,
      }),
      year,
      decisionType,
      source: labelSourceBuckets(source, sourceNames),
      language,
    },
    total: countedSearchTotal(SEARCH_TOTAL_TYPE.ESTIMATE, read.value.total),
  };
};

export const searchCorpusIndexDecisions = async (
  body: SearchDecisionsBody,
  caseLawDb: CaseLawPublicReadDb,
) => {
  const startedAt = performance.now();
  const limit = body.limit ?? LIMITS.caseLawSearchPageSizeDefault;
  const sort = body.sort ?? DEFAULT_SEARCH_SORT;

  let parsedCursor: CorpusSearchCursor | null = null;
  if (body.cursor) {
    parsedCursor = decodeCorpusSearchCursor(body.cursor);
    if (!parsedCursor || !isUuid(parsedCursor.id)) {
      return status(400, { message: "Invalid cursor" });
    }
  }

  if (!isCorpusIndexJurisdiction(body.country)) {
    return status(400, { message: "Invalid country" });
  }

  // Where the request's time went. The engine half is the scan's to report;
  // this side is every Postgres read, bracketed at the database call itself so
  // the numbers are wait, not work: the candidate read hands the timer down to
  // where it opens its transaction, because the ranking, folding and
  // collapsing around it are not database time.
  const dbTimer = createCaseLawSearchDbTimer();
  // Shared by the identity path and the scan, so `hydrated.size` counts the
  // candidates the whole request read, once each.
  const hydrated: HydratedDecisionRows = new Map();
  let pageRowsRead = 0;
  const grammar = decisionDocketGrammarForCountry(body.country);
  const intent = parseDecisionQuery(body.query, { grammar });
  const queryClass = decisionQueryClass(intent);
  const report = (hitsReturned: number, scan: CorpusIndexScanReport): void => {
    reportCaseLawSearchCompleted({
      candidatesHydrated: hydrated.size,
      country: body.country,
      db: dbTimer.timing(),
      hitsReturned,
      pageRowsRead,
      queryClass,
      totalMs: performance.now() - startedAt,
      ...scan,
    });
  };

  const serving = await dbTimer.time(
    CASE_LAW_SEARCH_DB_READ.servingGeneration,
    async () =>
      await caseLawDb(
        async (tx) => await readServingCorpusIndexGenerationTx(tx, "case_law"),
      ),
  );
  const generation = serving.generation;
  // Asserted before any engine work: every decision count this branch reports
  // is a cardinality over this field, so a generation that cannot aggregate
  // over it fails the search rather than serving passage counts as decisions.
  const decisionCountField = requireCaseLawDecisionCountField(generation);
  // Read once for the request and threaded through every hydration round: the
  // loader caches for a minute, but the ranking must see one registry across a
  // whole page. The timer brackets the query rather than the call, so a
  // request served from the cache reports no read instead of a phantom one.
  const courtWeights = await loadCourtWeights({
    onRead: async (run) =>
      await dbTimer.time(CASE_LAW_SEARCH_DB_READ.courtWeights, run),
  });

  /** The wide read, for the ids a page emits and no others. */
  const readPageRows = async (
    pageRanked: readonly RankedHit[],
  ): Promise<Map<string, PageDecisionRow>> => {
    const rows = await readCaseLawPageDecisionRows({
      body,
      caseLawDb,
      generation,
      ids: pageRanked.map((hit) => hit.id),
      timeDbRead: async (run) =>
        await dbTimer.time(CASE_LAW_SEARCH_DB_READ.page, run),
    });
    pageRowsRead += rows.size;
    return rows;
  };

  // An entry that names a decision is answered by identity, and only falls
  // through to the text index when nothing answers to it. A cursor means the
  // reader is already paging a text search, which identity never returns.
  if (intent.type === "identifier" && parsedCursor === null) {
    const ids = await findDecisionIdsByIdentity({
      caseLawDb,
      country: body.country,
      identity: intent,
      timeDbRead: async (run) =>
        await dbTimer.time(CASE_LAW_SEARCH_DB_READ.identity, run),
    });
    if (ids.length > 0) {
      const identityRanking = await rehydrateCaseLawCandidates({
        // Always the blended order here, whatever the request asked for: the
        // identity read has no order of its own to preserve, so the unblended
        // branch would hand back whatever order Postgres returned the ids in.
        body: { ...body, sort: DEFAULT_SEARCH_SORT },
        candidates: ids.map((id) => ({ id, score: 1 })),
        caseLawDb,
        courtWeights,
        generation,
        hydrated,
        timeDbRead: async (run) =>
          await dbTimer.time(CASE_LAW_SEARCH_DB_READ.candidates, run),
      });
      // A docket can name decisions at several courts; the page still honours
      // the requested size, and identity never pages past it.
      const identityPage = identityRanking.ranked.slice(0, limit);
      if (identityPage.length > 0) {
        const byId = await readPageRows(identityPage);
        // Timed around the call rather than through the timer's thunk: the
        // alternates read must stay a direct call in this function, which a
        // lint rule enforces so no search path can drop it.
        const identityAlternatesStartedAt = performance.now();
        const identityAlternates =
          await readPublicDecisionLanguageAlternatesByGroup({
            caseLawDb,
            languageGroupKeys: languageGroupKeysOf(identityPage, byId),
          });
        dbTimer.record(
          CASE_LAW_SEARCH_DB_READ.alternates,
          performance.now() - identityAlternatesStartedAt,
        );
        // An entry that names decisions outright is a lookup, not a ranking:
        // it returns what it names, so there is no result set to narrow and
        // no order for `sort` to apply to.
        const page = decisionHitsPage({
          alternatesByGroupKey: identityAlternates,
          anchorIdById: new Map(),
          byId,
          facets: null,
          nextCursor: null,
          pageRanked: identityPage,
          snippetById: new Map(),
          total: countedSearchTotal(
            SEARCH_TOTAL_TYPE.EXACT,
            identityPage.length,
          ),
        });
        report(page.hits.length, emptyCorpusIndexScan());
        return page;
      }
    }
  }

  // Scoped query → that country's index, plus a jurisdiction clause when that
  // index holds other countries; unscoped → the generation glob.
  const { indexId, jurisdictionClause } = corpusIndexRoute(
    generation,
    body.country,
  );

  const { facetQueries, resolved } = await resolveCorpusIndexQuery({
    body,
    generation,
    jurisdictionClause,
  });
  if (resolved.type === "empty") {
    report(0, emptyCorpusIndexScan());
    return {
      hits: [],
      facets: null,
      total: countedSearchTotal(SEARCH_TOTAL_TYPE.EXACT, 0),
      nextCursor: null,
    };
  }
  // A page boundary only means something inside the ranking that produced it,
  // and both the expansion dictionary and the sort order are part of that
  // ranking. A cursor from a different one is stale, and takes the same path a
  // tampered one does.
  if (
    isStaleCorpusSearchCursor(parsedCursor, {
      dictionary: resolved.dictionary,
      sort,
    })
  ) {
    return status(400, { message: "Invalid cursor" });
  }

  // The facets and the total describe the whole result set, so they are read
  // beside the scan rather than after it: nothing in the page depends on them,
  // and a reader waits through the slower of the two instead of the sum.
  // The decisions the requested order can rank. The page, the total and every
  // facet read the same narrowed query, so the counts describe the decisions
  // the pages reach.
  const scopedQuery = withCaseLawDatedDecisions(resolved.query, sort);

  const [searchPage, facetsAndTotal] = await Promise.all([
    readCorpusIndexSearchPage({
      cluster: serving.cluster,
      indexId,
      query: scopedQuery,
      limit,
      order: corpusSearchOrder(sort),
      parsedCursor,
      snippetFields: ["text"],
      extractId: (hit) => {
        const id = hit["document_id"];
        return typeof id === "string" && isUuid(id) ? id : null;
      },
      extractSnippet: extractCorpusSnippet,
      unseenScoreUpperBound: caseLawUnseenScoreUpperBound(sort),
      rankCandidates: async (candidates) =>
        await rehydrateCaseLawCandidates({
          body,
          candidates,
          caseLawDb,
          courtWeights,
          generation,
          hydrated,
          timeDbRead: async (run) =>
            await dbTimer.time(CASE_LAW_SEARCH_DB_READ.candidates, run),
        }),
    }),
    parsedCursor === null
      ? readCaseLawSearchFacets({
          body,
          caseLawDb,
          cluster: serving.cluster,
          courtWeights,
          decisionCountField,
          indexId,
          queryFor: facetQueries(),
          totalQuery: scopedQuery,
        })
      : null,
  ]);

  const { anchorIdById, pageRanked, scan, snippetById } = searchPage;

  const nextCursor =
    searchPage.nextCursor === null
      ? null
      : encodeCorpusSearchCursor({
          ...searchPage.nextCursor,
          dictionary: resolved.dictionary,
        });

  // A row the candidate read saw and this one no longer answers for was
  // scrubbed mid-request; it drops out of the page rather than being served
  // from a stale copy, and the cursor keeps pointing past it.
  const byId = await readPageRows(pageRanked);

  // Timed around the call for the same reason as on the identity path.
  const alternatesStartedAt = performance.now();
  const alternatesByGroupKey =
    await readPublicDecisionLanguageAlternatesByGroup({
      caseLawDb,
      languageGroupKeys: languageGroupKeysOf(pageRanked, byId),
    });
  dbTimer.record(
    CASE_LAW_SEARCH_DB_READ.alternates,
    performance.now() - alternatesStartedAt,
  );

  const page = decisionHitsPage({
    alternatesByGroupKey,
    anchorIdById,
    byId,
    facets: facetsAndTotal?.facets ?? null,
    nextCursor,
    pageRanked,
    snippetById,
    total: facetsAndTotal?.total ?? SEARCH_TOTAL_NOT_COUNTED,
  });
  report(page.hits.length, scan);
  return page;
};
