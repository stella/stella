import { Result } from "better-result";
import { and, eq, getColumns, inArray, sql } from "drizzle-orm";

import { SEARCH_PAGINATION_COMPLETE } from "@stll/api-contract/search";
import type { RegistryRequestObservation } from "@stll/business-registries/shared/request-observer";
import { isUuid } from "@stll/uuid-codec";

import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
// oxlint-disable-next-line no-restricted-imports -- search boundary: brands document ids returned by the corpus index before re-hydrating from Postgres
import { toSafeId, type SafeId } from "@/api/lib/branded-types";
import {
  caseLawPublicReadDb,
  type CaseLawPublicReadTransaction,
  type CaseLawPublicReadDb,
} from "@/api/lib/case-law-public-read-db";
import { decisionIdentifierProjection } from "@/api/lib/case-law/decision-identifiers";
import { publishedCaseLawDecision } from "@/api/lib/case-law/published-decisions";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import {
  caseLawCorpusAppliedRevision,
  caseLawCorpusDocumentCanRecur,
  currentCaseLawCorpusProjection,
} from "@/api/lib/legal-search/case-law-corpus-projection";
import {
  createCorpusHitDispositionCounter,
  reportCorpusHitDispositions,
  type CorpusHitDispositionCounter,
} from "@/api/lib/legal-search/corpus-hit-telemetry";
import { corpusIndexBrowseFacets } from "@/api/lib/legal-search/corpus-index-facets";
import { courtPartitionsForCourtFilter } from "@/api/lib/legal-search/corpus-index-group-contract";
import { readServingCorpusIndexTargetTx } from "@/api/lib/legal-search/corpus-index-group-enrollment-store";
import { requireCorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";
import { readCorpusIndexSearchPage } from "@/api/lib/legal-search/corpus-index-pagination";
import { caseLawCorpusQueryFields } from "@/api/lib/legal-search/corpus-index-read-contract";
import type { CorpusProjectionRevision } from "@/api/lib/legal-search/corpus-index-revision-clause";
import { markCorpusFragment } from "@/api/lib/legal-search/corpus-passage-highlight";
import {
  caseLawCorpusQuery,
  tokenizeCorpusFreeText,
} from "@/api/lib/legal-search/corpus-query";
import {
  corpusQueryVariant,
  corpusQueryVariantCursorTarget,
} from "@/api/lib/legal-search/corpus-query-variant-policy";
import {
  corpusQueryRankingMode,
  corpusRankingCursorTarget,
} from "@/api/lib/legal-search/corpus-ranking-policy";
import {
  partitionCorpusRehydration,
  recordCorpusRehydrationDispositions,
} from "@/api/lib/legal-search/corpus-rehydration-disposition";
import {
  corpusSearchGroupToken,
  decodeCorpusSearchCursor,
  encodeCorpusSearchCursor,
  isStaleCorpusSearchCursor,
} from "@/api/lib/legal-search/corpus-search-cursor";
import {
  DEFAULT_SEARCH_SORT,
  RELEVANCE_ORDER,
} from "@/api/lib/legal-search/corpus-search-order";
import { loadDocumentContext } from "@/api/lib/legal-search/document-context";
import { resolveExpandedCorpusQuery } from "@/api/lib/legal-search/expansion";
import {
  blendStableCitationAuthority,
  type ScoredCandidate,
  stableBlendUpperBound,
} from "@/api/lib/legal-search/rerank";
import {
  InvalidLegalSearchCursorError,
  type LegalSearchError,
  LegalSearchUnavailableError,
} from "@/api/lib/legal-search/search-error";
import type {
  LegalSearchHit,
  LegalSearchProvider,
  LegalSearchQuery,
  LegalSearchResult,
} from "@/api/lib/legal-search/types";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";
import { stripSearchHighlightMarkup } from "@/api/lib/search/highlight";

/**
 * corpus index legal-search provider: two-stage retrieve-then-rerank.
 * corpus index returns BM25 lexical candidates (filtered by tag/fast fields
 * for split pruning); the API re-joins them to the precomputed
 * citation_authority in Postgres and adds its saturated signal; corpus index has no
 * in-engine function scoring, so the legal-domain ranking stays here.
 *
 * Case-law generations built at passage granularity return one hit per
 * matching passage. Grouping to documents happens in
 * `readCorpusIndexSearchPage`, keyed on `document_id`: a document ranks by its
 * best passage, and that passage supplies the snippet and the deep-link
 * anchor. Both index layouts flow through unchanged — a document-granular
 * generation is just the case where every document has exactly one passage —
 * so the rerank, the cursor, and the Postgres rehydration below are untouched.
 */

const toNullableString = (x: unknown): string | null =>
  x === null ? null : JSON.stringify(x);

/**
 * The engine's snippet as plain text: the window it cut, without its own marks.
 *
 * corpus index wraps matched terms in `<b>` and escapes the surrounding text,
 * so the swap below hands `stripSearchHighlightMarkup` the one tag it strips.
 * The marks the response carries are put back by
 * {@link markCorpusFragment}, which reads the same terms the reader typed.
 */
const engineSnippetText = (
  snippet: Record<string, unknown> | undefined,
): string | null => {
  const text = snippet?.["text"];
  const raw = Array.isArray(text) ? text.join(" … ") : text;
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  return stripSearchHighlightMarkup(
    raw.replaceAll("<b>", "<mark>").replaceAll("</b>", "</mark>"),
  );
};

type MarkEngineSnippetOptions = Omit<
  Parameters<typeof markCorpusFragment>[0],
  "text"
> & {
  snippet: Record<string, unknown> | undefined;
};

const markEngineSnippet = ({
  snippet,
  tokens,
  language,
}: MarkEngineSnippetOptions): string | null => {
  const text = engineSnippetText(snippet);
  return text === null ? null : markCorpusFragment({ text, tokens, language });
};

type RehydrateCorpusIndexCandidatesOptions = {
  generation: string;
  ids: SafeId<"caseLawDecision">[];
};

export const rehydrateCorpusIndexProviderCandidatesStatement = (
  tx: CaseLawPublicReadTransaction,
  { generation, ids }: RehydrateCorpusIndexCandidatesOptions,
) => {
  const eligibleRows = tx
    .select({
      id: caseLawDecisions.id,
      caseNumber: caseLawDecisions.caseNumber,
      caseNumberType: caseLawDecisions.caseNumberType,
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
      ), '[]'::jsonb)`.as("identifiers"),
      court: caseLawDecisions.court,
      country: caseLawDecisions.country,
      language: caseLawDecisions.language,
      decisionDate: caseLawDecisions.decisionDate,
      decisionType: caseLawDecisions.decisionType,
      sourceUrl: caseLawDecisions.sourceUrl,
      citationCount: caseLawDecisions.citationCount,
      citationAuthority: caseLawDecisions.citationAuthority,
      createdAt: caseLawDecisions.createdAt,
      canRecur: caseLawCorpusDocumentCanRecur(generation).as("can_recur"),
      appliedRevision:
        caseLawCorpusAppliedRevision(generation).as("applied_revision"),
    })
    .from(caseLawDecisions)
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(
      and(
        inArray(caseLawDecisions.id, ids),
        redistributableCaseLawSource,
        publishedCaseLawDecision,
        currentCaseLawCorpusProjection(generation),
      ),
    )
    // Bounds the content branch and keeps its subplans behind eligibility.
    .limit(ids.length)
    .as("eligible_provider");
  return tx
    .select({ id: caseLawDecisions.id, row: getColumns(eligibleRows) })
    .from(caseLawDecisions)
    .leftJoin(eligibleRows, eq(caseLawDecisions.id, eligibleRows.id))
    .where(inArray(caseLawDecisions.id, ids))
    .limit(ids.length);
};

export const rehydrateCorpusIndexProviderCandidatesQuery = async (
  tx: CaseLawPublicReadTransaction,
  options: RehydrateCorpusIndexCandidatesOptions,
) =>
  partitionCorpusRehydration({
    ids: options.ids,
    records: await rehydrateCorpusIndexProviderCandidatesStatement(tx, options),
  });

export const rehydrateCorpusIndexProviderCandidates =
  definePublicLawSharedQuery(
    PUBLIC_LAW_SHARED_QUERY.caseLawCorpusIndexRehydration,
    async (
      tx: CaseLawPublicReadTransaction,
      options: RehydrateCorpusIndexCandidatesOptions,
    ) => await rehydrateCorpusIndexProviderCandidatesQuery(tx, options),
  );

type RankCorpusIndexProviderCandidatesOptions = {
  caseLawDb?: CaseLawPublicReadDb | undefined;
  hitDispositions?: CorpusHitDispositionCounter | undefined;
  generation: string;
  candidates: readonly ScoredCandidate[];
  /** Groups earlier pages emitted (`SearchCursor.excludedGroups`). */
  excludedGroups: readonly string[] | undefined;
};

export const rankCorpusIndexProviderCandidates = async ({
  caseLawDb = caseLawPublicReadDb,
  hitDispositions = createCorpusHitDispositionCounter(),
  generation,
  candidates,
  excludedGroups,
}: RankCorpusIndexProviderCandidatesOptions) => {
  const ids = candidates.map((candidate) =>
    toSafeId<"caseLawDecision">(candidate.id),
  );
  const read =
    ids.length === 0
      ? { rows: [], dispositions: [] }
      : await caseLawDb(
          async (tx) =>
            await rehydrateCorpusIndexProviderCandidates(tx, {
              generation,
              ids,
            }),
        );

  recordCorpusRehydrationDispositions(read.dispositions, hitDispositions);
  const rows = read.rows;

  // Keyed by plain string id (candidate ids from corpus index are strings).
  const displayById = new Map(rows.map((row) => [String(row.id), row]));
  const authorityById = new Map(
    rows.map((row) => [String(row.id), row.citationAuthority]),
  );
  const revisionById = new Map<string, CorpusProjectionRevision>();
  for (const { id, appliedRevision } of rows) {
    if (appliedRevision !== null) {
      revisionById.set(String(id), appliedRevision);
    }
  }

  // Drop candidates missing from Postgres (index/DB drift) so we never
  // surface a hit we cannot render. Only documents with later physical
  // passages need exclusions when the position window advances.
  const excluded = new Set(excludedGroups);
  const rendered = candidates.filter(
    (candidate) =>
      displayById.has(candidate.id) && revisionById.has(candidate.id),
  );
  return {
    context: { displayById },
    revisionById,
    groups: rendered.flatMap((candidate) =>
      displayById.get(candidate.id)?.canRecur
        ? [corpusSearchGroupToken(candidate.id)]
        : [],
    ),
    ranked: blendStableCitationAuthority({
      candidates: rendered.filter(
        (candidate) => !excluded.has(corpusSearchGroupToken(candidate.id)),
      ),
      authorityById,
    }),
  };
};

type CorpusIndexSearchResultOptions = {
  query: LegalSearchQuery;
  observer: RegistryRequestObservation;
  hitDispositions: CorpusHitDispositionCounter;
};

type CorpusIndexSearchResult = Result<LegalSearchResult, LegalSearchError>;

const searchResult = async (
  options: CorpusIndexSearchResultOptions,
): Promise<CorpusIndexSearchResult> => {
  const { query, observer, hitDispositions } = options;
  const family = query.documentFamily ?? "case_law";

  // Before the generation read, and before any engine work: a cursor that does
  // not decode must fail rather than fall back to page one, which a client
  // appending pages cannot tell from a page and reads as duplicates.
  const parsedCursor = query.cursor
    ? decodeCorpusSearchCursor(query.cursor)
    : null;
  if (query.cursor !== undefined && parsedCursor === null) {
    return Result.err(
      new InvalidLegalSearchCursorError({
        message: "Search cursor did not decode.",
        reason: "undecodable",
      }),
    );
  }

  const target = await caseLawPublicReadDb(
    async (tx) =>
      await readServingCorpusIndexTargetTx(tx, {
        family,
        jurisdiction: query.jurisdiction,
      }),
  );
  if (Result.isError(target)) {
    return Result.err(
      new LegalSearchUnavailableError({
        message: "Corpus index legal search reached an unready index group.",
        cause: target.error,
      }),
    );
  }
  const { serving, route, contract } = target.value;
  const rankingMode = corpusQueryRankingMode({
    configuredMode: envBase.CORPUS_INDEX_RANKING_MODE,
    sort: "relevance",
    textTokenCount: tokenizeCorpusFreeText(query.query).length,
  });
  const queryVariant = corpusQueryVariant({
    configuredVariant: envBase.CORPUS_INDEX_QUERY_VARIANT,
    verbatim: false,
  });
  const cursorTarget = corpusQueryVariantCursorTarget(
    corpusRankingCursorTarget(target.value.cursorTarget, rankingMode),
    queryVariant,
  );
  const generation = serving.generation;

  // Scoped query → that jurisdiction's index, plus a jurisdiction clause when
  // that index holds other jurisdictions; unscoped → every index of the
  // generation a read may reach (`corpusIndexReadTarget`).
  const { indexId, jurisdictionClause } = route;

  // The jurisdiction also selects the expansion dictionary, which is why the
  // resolver takes it separately from the clause.
  // The generation decides which fields exist to be named; the language
  // filter, then the jurisdiction, decides how the reader's words are stemmed.
  const fields = caseLawCorpusQueryFields({
    generation,
    jurisdiction: query.jurisdiction,
    language: query.language,
  });
  const resolved = await resolveExpandedCorpusQuery({
    build: (expand) =>
      caseLawCorpusQuery({
        jurisdiction: query.jurisdiction,
        text: query.query,
        queryVariant,
        filters: {
          court: query.court,
          courtPartitions: courtPartitionsForCourtFilter(contract, query.court),
          dateFrom: query.dateFrom,
          dateTo: query.dateTo,
          documentType: query.documentType,
          jurisdiction: jurisdictionClause,
          language: query.language,
          source: query.source,
        },
        expand,
        ...fields,
        functionWords: null,
      }),
    jurisdiction: query.jurisdiction,
    mode: envBase.QUERY_EXPANSION_MODE,
    text: query.query,
  });
  if (resolved.type === "empty") {
    return Result.ok({
      hits: [],
      facets: null,
      nextCursor: null,
      paginationOutcome: SEARCH_PAGINATION_COMPLETE,
      limit: query.limit,
    });
  }
  // This boundary has no HTTP status to answer with, so a cursor from another
  // dictionary or read target fails the read rather than paging a different
  // result set.
  if (
    parsedCursor !== null &&
    isStaleCorpusSearchCursor(parsedCursor, {
      dictionary: resolved.dictionary,
      sort: DEFAULT_SEARCH_SORT,
      target: cursorTarget,
    })
  ) {
    return Result.err(
      parsedCursor.target === cursorTarget
        ? new InvalidLegalSearchCursorError({
            message:
              "Search cursor was built against a different expansion dictionary.",
            reason: "dictionary_mismatch",
          })
        : new InvalidLegalSearchCursorError({
            message: "Search cursor was built against a different read target.",
            reason: "target_mismatch",
          }),
    );
  }

  // The reader's own words, not the expanded query: an expansion term is a
  // reason a document ranks, not a word the reader asked to see marked.
  const snippetTokens = tokenizeCorpusFreeText(query.query);

  const searchPage = await readCorpusIndexSearchPage({
    hitDispositions,
    observer,
    cluster: serving.cluster,
    indexId,
    query: resolved.query,
    limit: query.limit,
    // The shared provider ranks best-first only; the public search handler
    // owns the reader-chosen orders.
    order: RELEVANCE_ORDER,
    parsedCursor,
    rankingMode,
    fallbackScanTransport: { type: "native" },
    scanTransport:
      rankingMode === "bm25-ratio" ? { type: "scored" } : { type: "native" },
    snippetFields: ["text"],
    projectionRevisionField: requireCorpusIndexManifest(family, generation)
      .projection.projectionRevisionField,
    extractId: (hit) => {
      const id = hit["document_id"];
      return typeof id === "string" && isUuid(id) ? id : null;
    },
    // The engine picks the window, the marks are put on here: the engine marks
    // the tokens its query names, so an inflected form is left unmarked inside
    // a window that was returned for it, and a quoted phrase is marked word by
    // word. Marking the window the engine already sent back keeps that off the
    // read path: no passage is fetched per hit.
    extractSnippet: (snippet) =>
      markEngineSnippet({
        snippet,
        tokens: snippetTokens,
        language: fields.stemming?.language ?? null,
      }),
    // Upper bound for the pagination early-stop: scanning may end only once
    // no unseen candidate could out-blend the page cursor. Saturated
    // authority is bounded by 1, so the bound reads nothing from the corpus.
    unseenScoreUpperBound: stableBlendUpperBound,
    rankCandidates: async (candidates) =>
      await rankCorpusIndexProviderCandidates({
        hitDispositions,
        generation,
        candidates,
        excludedGroups: parsedCursor?.excludedGroups,
      }),
  });

  const {
    anchorIdById,
    context: { displayById },
    pageRanked,
    passageCountById,
    snippetById,
  } = searchPage;

  const nextCursor =
    searchPage.nextCursor === null
      ? null
      : encodeCorpusSearchCursor({
          ...searchPage.nextCursor,
          dictionary: resolved.dictionary,
          target: cursorTarget,
        });

  const hits: LegalSearchHit[] = pageRanked.flatMap((hit) => {
    const row = displayById.get(hit.id);
    if (!row) {
      return [];
    }
    return [
      {
        decisionId: row.id,
        caseNumber: row.caseNumber,
        ecli: toNullableString(row.ecli),
        identifiers: decisionIdentifierProjection(row.identifiers, {
          caseNumber: row.caseNumber,
          caseNumberType: row.caseNumberType,
          ecli: toNullableString(row.ecli),
        }),
        court: row.court,
        country: row.country,
        language: row.language,
        decisionDate: toNullableString(row.decisionDate),
        decisionType: toNullableString(row.decisionType),
        sourceUrl: toNullableString(row.sourceUrl),
        headline: snippetById.get(hit.id) ?? null,
        anchorId: anchorIdById.get(hit.id) ?? null,
        matchingPassages: passageCountById.get(hit.id) ?? 1,
        citationCount: row.citationCount,
        citationAuthority: hit.citationAuthority,
        score: hit.score,
        createdAt: row.createdAt.toISOString(),
      },
    ];
  });

  // Exact facet counts over broad queries are expensive in corpus index; the
  // shipped UI already tolerates null facets (returned on paginated
  // pages). corpus index aggregations are a follow-up.
  return Result.ok({
    hits,
    facets: null,
    nextCursor,
    paginationOutcome: searchPage.paginationOutcome,
    limit: query.limit,
  });
};

const search = async (
  query: LegalSearchQuery,
  observer: RegistryRequestObservation,
): Promise<Result<LegalSearchResult, LegalSearchError>> => {
  const hitDispositions = createCorpusHitDispositionCounter();
  const attempted = await Result.tryPromise({
    try: async () => await searchResult({ query, observer, hitDispositions }),
    catch: (cause) =>
      new LegalSearchUnavailableError({
        message: "Corpus index legal search failed.",
        cause,
      }),
  });
  reportCorpusHitDispositions({
    family: query.documentFamily ?? "case_law",
    counts: hitDispositions.snapshot(),
  });
  if (Result.isError(attempted)) {
    return attempted;
  }
  return attempted.value;
};

export const corpusIndexProvider: LegalSearchProvider = {
  search,
  browseFacets: corpusIndexBrowseFacets,
  getDocumentContext: loadDocumentContext,
};
