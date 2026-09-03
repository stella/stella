import { and, eq, inArray, sql } from "drizzle-orm";

import {
  caseLawCorpusIndexProjections,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
// eslint-disable-next-line no-restricted-imports -- search boundary: brands document ids returned by the corpus index before re-hydrating from Postgres
import { toSafeId, type SafeId } from "@/api/lib/branded-types";
import {
  caseLawPublicReadDb,
  type CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { decisionIdentifierProjection } from "@/api/lib/case-law/decision-identifiers";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { isUuid } from "@/api/lib/custom-schema";
import {
  caseLawCorpusProjectionJoin,
  currentCaseLawCorpusProjection,
} from "@/api/lib/legal-search/case-law-corpus-projection";
import { corpusIndexBrowseFacets } from "@/api/lib/legal-search/corpus-index-facets";
import { readServingCorpusIndexGenerationTx } from "@/api/lib/legal-search/corpus-index-generation-store";
import { readCorpusIndexSearchPage } from "@/api/lib/legal-search/corpus-index-pagination";
import { caseLawCorpusQueryFields } from "@/api/lib/legal-search/corpus-index-read-contract";
import { caseLawCorpusQuery } from "@/api/lib/legal-search/corpus-query";
import {
  decodeCorpusSearchCursor,
  encodeCorpusSearchCursor,
  InvalidCorpusSearchCursorError,
  isStaleCorpusSearchCursor,
} from "@/api/lib/legal-search/corpus-search-cursor";
import { loadDocumentContext } from "@/api/lib/legal-search/document-context";
import { resolveExpandedCorpusQuery } from "@/api/lib/legal-search/expansion";
import { corpusIndexRoute } from "@/api/lib/legal-search/index-naming";
import {
  blendStableCitationAuthority,
  stableBlendUpperBound,
} from "@/api/lib/legal-search/rerank";
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

/**
 * corpus index legal-search provider: two-stage retrieve-then-rerank.
 * corpus index returns BM25 lexical candidates (filtered by tag/fast fields
 * for split pruning); the API re-joins them to the precomputed
 * citation_authority in Postgres and blends via RRF — corpus index has no
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

const extractSnippet = (
  snippet: Record<string, unknown> | undefined,
): string | null => {
  const text = snippet?.["text"];
  const raw = Array.isArray(text) ? text.join(" … ") : text;
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  // corpus index wraps matched terms in <b>; the UI renders <mark>. corpus index
  // escapes the surrounding text, so this swap is safe. Aligning fully
  // with the pg ts_headline pipeline is a follow-up.
  return raw.replaceAll("<b>", "<mark>").replaceAll("</b>", "</mark>");
};

type RehydrateCorpusIndexCandidatesOptions = {
  generation: string;
  ids: SafeId<"caseLawDecision">[];
};

export const rehydrateCorpusIndexProviderCandidates =
  definePublicLawSharedQuery(
    PUBLIC_LAW_SHARED_QUERY.caseLawCorpusIndexRehydration,
    async (
      tx: CaseLawPublicReadTransaction,
      { generation, ids }: RehydrateCorpusIndexCandidatesOptions,
    ) =>
      await tx
        .select({
          id: caseLawDecisions.id,
          caseNumber: caseLawDecisions.caseNumber,
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
          decisionDate: caseLawDecisions.decisionDate,
          decisionType: caseLawDecisions.decisionType,
          sourceUrl: caseLawDecisions.sourceUrl,
          citationCount: caseLawDecisions.citationCount,
          citationAuthority: caseLawDecisions.citationAuthority,
          createdAt: caseLawDecisions.createdAt,
        })
        .from(caseLawDecisions)
        .leftJoin(
          caseLawCorpusIndexProjections,
          caseLawCorpusProjectionJoin(generation),
        )
        .innerJoin(
          caseLawSources,
          eq(caseLawSources.id, caseLawDecisions.sourceId),
        )
        .where(
          and(
            inArray(caseLawDecisions.id, ids),
            redistributableCaseLawSource,
            currentCaseLawCorpusProjection(generation),
          ),
        ),
  );

const search = async (query: LegalSearchQuery): Promise<LegalSearchResult> => {
  const limit = query.limit;
  const family = query.documentFamily ?? "case_law";

  // Before the generation read, and before any engine work: a cursor that does
  // not decode must fail rather than fall back to page one, which a client
  // appending pages cannot tell from a page and reads as duplicates.
  const parsedCursor = query.cursor
    ? decodeCorpusSearchCursor(query.cursor)
    : null;
  if (query.cursor !== undefined && parsedCursor === null) {
    throw new InvalidCorpusSearchCursorError({
      message: "Search cursor did not decode.",
      reason: "undecodable",
    });
  }

  const serving = await caseLawPublicReadDb(
    async (tx) => await readServingCorpusIndexGenerationTx(tx, family),
  );
  const generation = serving.generation;

  // Scoped query → that jurisdiction's index, plus a jurisdiction clause when
  // that index holds other jurisdictions; unscoped → the generation glob
  // (corpus index multi-index search across all of the generation's indexes).
  const { indexId, jurisdictionClause } = corpusIndexRoute(
    generation,
    query.jurisdiction,
  );

  // The jurisdiction also selects the expansion dictionary, which is why the
  // resolver takes it separately from the clause.
  // The generation decides which fields exist to be named; the language
  // filter, then the jurisdiction, decides how the reader's words are stemmed.
  const { surfaceFields, stemming } = caseLawCorpusQueryFields({
    generation,
    jurisdiction: query.jurisdiction,
    language: query.language,
  });
  const resolved = await resolveExpandedCorpusQuery({
    build: (expand) =>
      caseLawCorpusQuery({
        text: query.query,
        filters: {
          court: query.court,
          dateFrom: query.dateFrom,
          dateTo: query.dateTo,
          documentType: query.documentType,
          jurisdiction: jurisdictionClause,
          language: query.language,
          source: query.source,
        },
        expand,
        stemming,
        surfaceFields,
      }),
    jurisdiction: query.jurisdiction,
    mode: envBase.QUERY_EXPANSION_MODE,
    text: query.query,
  });
  if (resolved.type === "empty") {
    return { hits: [], facets: null, nextCursor: null, limit };
  }
  // This boundary has no HTTP status to answer with, so a cursor from another
  // dictionary fails the read rather than paging a different result set.
  if (isStaleCorpusSearchCursor(parsedCursor, resolved.dictionary)) {
    throw new InvalidCorpusSearchCursorError({
      message:
        "Search cursor was built against a different expansion dictionary.",
      reason: "dictionary_mismatch",
    });
  }

  const searchPage = await readCorpusIndexSearchPage({
    cluster: serving.cluster,
    indexId,
    query: resolved.query,
    limit,
    parsedCursor,
    snippetFields: ["text"],
    extractId: (hit) => {
      const id = hit["document_id"];
      return typeof id === "string" && isUuid(id) ? id : null;
    },
    extractSnippet,
    // Upper bound for the pagination early-stop: scanning may end only once
    // no unseen candidate could out-blend the page cursor. Saturated
    // authority is bounded by 1, so the bound reads nothing from the corpus.
    unseenScoreUpperBound: stableBlendUpperBound,
    rankCandidates: async (candidates) => {
      const ids = candidates.map((candidate) =>
        toSafeId<"caseLawDecision">(candidate.id),
      );
      const rows =
        ids.length === 0
          ? []
          : await caseLawPublicReadDb(
              async (tx) =>
                await rehydrateCorpusIndexProviderCandidates(tx, {
                  generation,
                  ids,
                }),
            );

      // Keyed by plain string id (candidate ids from corpus index are strings).
      const displayById = new Map(rows.map((row) => [String(row.id), row]));
      const authorityById = new Map(
        rows.map((row) => [String(row.id), row.citationAuthority]),
      );

      // Drop candidates missing from Postgres (index/DB drift) so we never
      // surface a hit we cannot render.
      return {
        context: { displayById },
        ranked: blendStableCitationAuthority({
          candidates: candidates.filter((candidate) =>
            displayById.has(candidate.id),
          ),
          authorityById,
        }),
      };
    },
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
  return { hits, facets: null, nextCursor, limit };
};

export const corpusIndexProvider: LegalSearchProvider = {
  search,
  browseFacets: corpusIndexBrowseFacets,
  getDocumentContext: loadDocumentContext,
};
