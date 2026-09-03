import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status } from "elysia";
import type { Static } from "elysia";

import {
  type DecisionQueryIntent,
  parseDecisionQuery,
} from "@stll/api-contract/decision-query-intent";

import {
  caseLawCorpusIndexProjections,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import {
  courtWeightSql,
  polarityWeightSql,
} from "@/api/handlers/case-law/citation-score";
import { loadCourtWeightEntriesForSql } from "@/api/handlers/case-law/court-weights";
import type { searchDecisionsBodySchema } from "@/api/handlers/case-law/decisions/search-schema";
import { bareCitationKey } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { arrayOrEmpty } from "@/api/lib/array";
// eslint-disable-next-line no-restricted-imports -- search boundary: brands document ids returned by the corpus index before re-hydrating from Postgres
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import {
  decisionHeadnoteSql,
  normalizeDecisionHeadnote,
} from "@/api/lib/case-law/decision-headnote";
import { decisionIdentifierProjection } from "@/api/lib/case-law/decision-identifiers";
import { readPublicDecisionLanguageAlternatesByGroup } from "@/api/lib/case-law/language-alternates";
import {
  redistributableCaseLawSource,
  redistributableCaseLawSourceSqlFor,
} from "@/api/lib/case-law/redistribution";
import {
  bodyPreviewJoin,
  redistributableSourceJoin,
} from "@/api/lib/case-law/search-sql";
import { isUuid } from "@/api/lib/custom-schema";
import { blendedRankSql } from "@/api/lib/legal-search/authority-sql";
import {
  caseLawCorpusProjectionJoin,
  currentCaseLawCorpusProjection,
} from "@/api/lib/legal-search/case-law-corpus-projection";
import { readServingCorpusIndexGenerationTx } from "@/api/lib/legal-search/corpus-index-generation-store";
import { readCorpusIndexSearchPage } from "@/api/lib/legal-search/corpus-index-pagination";
import {
  caseLawCorpusQuery,
  type CorpusTermExpander,
} from "@/api/lib/legal-search/corpus-query";
import { resolveExpandedCorpusQuery } from "@/api/lib/legal-search/expansion";
import { loadFtsSearchConfigs } from "@/api/lib/legal-search/fts-config";
import {
  corpusIndexRoute,
  isCorpusIndexJurisdiction,
} from "@/api/lib/legal-search/index-naming";
import { collapseByLanguageGroup } from "@/api/lib/legal-search/language-group-collapse";
import { buildPgFtsSearchSql } from "@/api/lib/legal-search/pg-fts-query";
import {
  blendStableCitationAuthority,
  stableBlendUpperBound,
} from "@/api/lib/legal-search/rerank";
import type { RankedHit, ScoredCandidate } from "@/api/lib/legal-search/rerank";
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

  // Validate cursor early so a tampered value fails visibly
  let parsedCursor: { score: number; id: string } | null = null;
  if (body.cursor) {
    parsedCursor = decodeCursor(body.cursor);
    if (!parsedCursor || !isUuid(parsedCursor.id)) {
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

  const scoreExpr = blendedRankSql(ftsSearch.rank, sql`cb.authority`);

  // The ORDER BY and the cursor predicate read the same materialized score
  // column: keyset pagination is only stable while the two agree.
  const cursorFilter = parsedCursor
    ? sql`AND (m.score, m.decision_id) < (
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

  // DB-seeded weights (case_law_court_weights, 60s cache) cover every
  // jurisdiction; courtWeightSql falls back to the legacy CZ/SK-only
  // tiers only when the table has not been seeded yet.
  const courtWeightEntries = await loadCourtWeightEntriesForSql();
  const courtWeightExpr = courtWeightSql("citing_d.court", courtWeightEntries);

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
        ${scoreExpr} AS score,
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
  // is its best-scoring matched version, id as the tie-break: a property of
  // the row and the query, not of the page, so the keyset cursor stays valid
  // across pages.
  const representativeFilter = sql`
    (
      m.language_group_key IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM matched sibling
        WHERE sibling.language_group_key = m.language_group_key
          AND (sibling.score, sibling.decision_id) > (m.score, m.decision_id)
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
      ${decisionHeadnoteSql(sql.raw("d.metadata"))} AS headnote,
      ts_headline(
        ${headlineRegconfig},
        left(
          coalesce(nullif(body_preview.text, ''), d.fulltext, sd.searchable_text),
          ${LIMITS.searchHeadlineDocumentMaxChars}
        ),
        ${ftsSearch.headlineQuery},
        ${TS_HEADLINE_CONFIG}
      ) AS headline,
      m.score,
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
    ORDER BY m.score DESC, m.decision_id DESC
    LIMIT ${limit + 1}
  `;

  const countQuery = sql`
    WITH ${matchedCte}
    SELECT count(*)::int AS total
    FROM matched m
    WHERE ${representativeFilter}
  `;

  // Court and country facets count judgments, not language versions: a
  // multilingual decision contributes one to its court however many versions
  // matched. The language facet is per version by definition.
  const judgmentCountSql = sql`
    count(distinct coalesce(d.language_group_key, sd.decision_id::text))::int
  `;

  // Court facet: cross-filtered (respects country + language)
  const courtFacetQuery = sql`
    SELECT d.court AS value, ${judgmentCountSql} AS count
    FROM case_law_search_documents sd
    JOIN case_law_decisions d
      ON d.id = sd.decision_id
    ${redistributableSourceJoin}
    WHERE ${ftsSearch.predicate}
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
    SELECT d.country AS value, ${judgmentCountSql} AS count
    FROM case_law_search_documents sd
    JOIN case_law_decisions d
      ON d.id = sd.decision_id
    ${redistributableSourceJoin}
    WHERE ${ftsSearch.predicate}
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
    ${redistributableSourceJoin}
    WHERE ${ftsSearch.predicate}
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

  const hitsResult = arrayOrEmpty(hitsResultRaw);
  const countResult = arrayOrEmpty(countResultRaw);
  const courtResult = arrayOrEmpty(courtResultRaw);
  const countryResult = arrayOrEmpty(countryResultRaw);
  const languageResult = arrayOrEmpty(languageResultRaw);

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
      ? encodeCursor(Number(lastRaw["score"]), String(lastRaw["decision_id"]))
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
      headnote: normalizeDecisionHeadnote(row["headnote"]),
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

// `country` is deliberately absent from the filters: it selects the index,
// not a clause. It does select the expansion dictionary, which is why the
// expander is resolved from it here rather than inside the query builder.
const buildCorpusIndexQuery = (
  body: SearchDecisionsBody,
  jurisdictionClause: string | undefined,
  expand?: CorpusTermExpander,
): string | null =>
  caseLawCorpusQuery(
    body.query,
    {
      court: body.court,
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
      documentType: body.decisionType,
      jurisdiction: jurisdictionClause,
      language: body.language,
      source: body.sourceId,
    },
    expand,
  );

/** Mode, dictionary, and shadow accounting are the shared resolver's. */
const resolveCorpusIndexQuery = async (
  body: SearchDecisionsBody,
  jurisdictionClause: string | undefined,
): Promise<string | null> =>
  await resolveExpandedCorpusQuery({
    build: (expand) => buildCorpusIndexQuery(body, jurisdictionClause, expand),
    jurisdiction: body.country,
    mode: envBase.QUERY_EXPANSION_MODE,
    text: body.query,
  });

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

const hydratedDecisionRowsQuery = (
  tx: CaseLawPublicReadTransaction,
  ids: SafeId<"caseLawDecision">[],
  filters: SQL[],
  generation: string,
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
      headnote: decisionHeadnoteSql(caseLawDecisions.metadata),
      citationCount: caseLawDecisions.citationCount,
      citationAuthority: caseLawDecisions.citationAuthority,
      createdAt: caseLawDecisions.createdAt,
    })
    .from(caseLawDecisions)
    .leftJoin(
      caseLawCorpusIndexProjections,
      caseLawCorpusProjectionJoin(generation),
    )
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(and(inArray(caseLawDecisions.id, ids), ...filters));

type HydratedDecisionRow = Awaited<
  ReturnType<typeof hydratedDecisionRowsQuery>
>[number];

type RehydrateCaseLawCandidatesOptions = {
  body: SearchDecisionsBody;
  candidates: readonly ScoredCandidate[];
  caseLawDb: CaseLawPublicReadDb;
  generation: string;
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
  generation,
}: RehydrateCaseLawCandidatesOptions) => {
  const ids = candidates.map((candidate) =>
    toSafeId<"caseLawDecision">(candidate.id),
  );
  // Reapply the request filters against the current rows: a stale
  // corpus hit (metadata changed, async re-index/delete pending) must
  // not satisfy filters it no longer matches.
  const rehydrationFilters: SQL[] = [
    redistributableCaseLawSource,
    // Prefer the generation-specific projection state; generations that
    // predate durable rebuild checkpoints fall back to the serving marker.
    // Both paths reject a scrubbed or pending row, so a stale physical
    // copy cannot serve outdated or erased snippets.
    currentCaseLawCorpusProjection(generation),
  ];
  if (body.court) {
    rehydrationFilters.push(eq(caseLawDecisions.court, body.court));
  }
  if (body.country) {
    rehydrationFilters.push(eq(caseLawDecisions.country, body.country));
  }
  if (body.dateFrom) {
    rehydrationFilters.push(
      sql`${caseLawDecisions.decisionDate} >= ${body.dateFrom}`,
    );
  }
  if (body.dateTo) {
    rehydrationFilters.push(
      sql`${caseLawDecisions.decisionDate} <= ${body.dateTo}`,
    );
  }
  if (body.decisionType) {
    rehydrationFilters.push(
      eq(caseLawDecisions.decisionType, body.decisionType),
    );
  }
  if (body.sourceId) {
    rehydrationFilters.push(eq(caseLawDecisions.sourceId, body.sourceId));
  }
  if (body.language) {
    rehydrationFilters.push(eq(caseLawDecisions.language, body.language));
  }
  const rows =
    ids.length === 0
      ? []
      : await caseLawDb((tx) =>
          hydratedDecisionRowsQuery(tx, ids, rehydrationFilters, generation),
        );
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const authorityById = new Map(
    rows.map((row) => [String(row.id), row.citationAuthority]),
  );

  // Candidates missing from Postgres (index/DB drift) are dropped. Every
  // version is blended before the fold, so a version whose citation authority
  // lifts it past a lexically stronger sibling still stands for the judgment;
  // the versions of one decision then fold into their best-blended member. The
  // scan's early-stop bound guarantees no unseen version could out-blend an
  // emitted page, so the representative is the same on every rescan.
  const ranked = blendStableCitationAuthority({
    candidates: candidates.filter((candidate) => byId.has(candidate.id)),
    authorityById,
  });
  const { representatives } = collapseByLanguageGroup(
    ranked,
    (hitId) => byId.get(hitId)?.languageGroupKey ?? null,
  );

  return { context: { byId }, ranked: representatives };
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
export const findDecisionIdsByIdentity = async (
  caseLawDb: CaseLawPublicReadDb,
  identity: DecisionIdentity,
  country: string | undefined,
): Promise<SafeId<"caseLawDecision">[]> => {
  const identityPredicate =
    identity.kind === "ecli"
      ? inArray(caseLawDecisions.ecli, [
          identity.value,
          identity.value.toUpperCase(),
        ])
      : eq(caseLawDecisions.citationKey, bareCitationKey(identity.value));
  const rows = await caseLawDb((tx) =>
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
  );
  return rows.map((row) => row.id);
};

/** The language groups a page spans, for the alternates read. */
const languageGroupKeysOf = (
  pageRanked: readonly RankedHit[],
  byId: ReadonlyMap<string, HydratedDecisionRow>,
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
  byId: ReadonlyMap<string, HydratedDecisionRow>;
  nextCursor: string | null;
  pageRanked: readonly RankedHit[];
  snippetById: ReadonlyMap<string, string>;
};

/** One page of ranked, hydrated decisions in the search response shape. */
const decisionHitsPage = ({
  alternatesByGroupKey,
  anchorIdById,
  byId,
  nextCursor,
  pageRanked,
  snippetById,
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
        headnote: normalizeDecisionHeadnote(row.headnote),
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
    facets: null,
    totalCount: null,
    nextCursor,
  };
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

  const serving = await caseLawDb(
    async (tx) => await readServingCorpusIndexGenerationTx(tx, "case_law"),
  );
  const generation = serving.generation;

  // An entry that names a decision is answered by identity, and only falls
  // through to the text index when nothing answers to it. A cursor means the
  // reader is already paging a text search, which identity never returns.
  const intent = parseDecisionQuery(body.query);
  if (intent.type === "identifier" && parsedCursor === null) {
    const ids = await findDecisionIdsByIdentity(
      caseLawDb,
      intent,
      body.country,
    );
    if (ids.length > 0) {
      const identityRanking = await rehydrateCaseLawCandidates({
        body,
        candidates: ids.map((id) => ({ id, score: 1 })),
        caseLawDb,
        generation,
      });
      // A docket can name decisions at several courts; the page still honours
      // the requested size, and identity never pages past it.
      const identityPage = identityRanking.ranked.slice(0, limit);
      if (identityPage.length > 0) {
        const { byId } = identityRanking.context;
        return decisionHitsPage({
          alternatesByGroupKey:
            await readPublicDecisionLanguageAlternatesByGroup({
              caseLawDb,
              languageGroupKeys: languageGroupKeysOf(identityPage, byId),
            }),
          anchorIdById: new Map(),
          byId,
          nextCursor: null,
          pageRanked: identityPage,
          snippetById: new Map(),
        });
      }
    }
  }

  // Scoped query → that country's index, plus a jurisdiction clause when that
  // index holds other countries; unscoped → the generation glob.
  const { indexId, jurisdictionClause } = corpusIndexRoute(
    generation,
    body.country,
  );

  const query = await resolveCorpusIndexQuery(body, jurisdictionClause);
  if (query === null) {
    return { hits: [], facets: null, totalCount: null, nextCursor: null };
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
      await rehydrateCaseLawCandidates({
        body,
        candidates,
        caseLawDb,
        generation,
      }),
  });

  const {
    anchorIdById,
    context: { byId },
    hasMore,
    pageRanked,
    snippetById,
  } = searchPage;

  const last = pageRanked.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.score, last.id) : null;

  return decisionHitsPage({
    alternatesByGroupKey: await readPublicDecisionLanguageAlternatesByGroup({
      caseLawDb,
      languageGroupKeys: languageGroupKeysOf(pageRanked, byId),
    }),
    anchorIdById,
    byId,
    nextCursor,
    pageRanked,
    snippetById,
  });
};
