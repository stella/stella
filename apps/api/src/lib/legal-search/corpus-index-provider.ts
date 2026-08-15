import { and, eq, inArray, sql } from "drizzle-orm";

import {
  caseLawCorpusIndexProjections,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
// eslint-disable-next-line no-restricted-imports -- search boundary: brands document ids returned by the corpus index before re-hydrating from Postgres
import { toSafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { isUuid } from "@/api/lib/custom-schema";
import {
  caseLawCorpusProjectionJoin,
  currentCaseLawCorpusProjection,
} from "@/api/lib/legal-search/case-law-corpus-projection";
import { corpusGeneration } from "@/api/lib/legal-search/corpus-family";
import { readCorpusIndexSearchPage } from "@/api/lib/legal-search/corpus-index-pagination";
import { caseLawCorpusQuery } from "@/api/lib/legal-search/corpus-query";
import { loadDocumentContext } from "@/api/lib/legal-search/document-context";
import { resolveExpandedCorpusQuery } from "@/api/lib/legal-search/expansion";
import {
  corpusIndexId,
  corpusIndexPattern,
} from "@/api/lib/legal-search/index-naming";
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
import { encodeCursor, decodeCursor } from "@/api/lib/search/cursor";

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

const search = async (query: LegalSearchQuery): Promise<LegalSearchResult> => {
  const limit = query.limit;
  const generation = corpusGeneration(query.documentFamily ?? "case_law");

  // Scoped query → that jurisdiction's index; unscoped → the generation
  // glob (corpus index multi-index search across all jurisdiction indexes).
  const indexId = query.jurisdiction
    ? corpusIndexId(generation, query.jurisdiction)
    : corpusIndexPattern(generation);

  const parsedCursor = query.cursor ? decodeCursor(query.cursor) : null;

  // jurisdiction is deliberately absent from the filters: it selected the
  // index above, so a scoped query never needs a clause for it. It does select
  // the expansion dictionary, which is why the resolver takes it separately.
  const engineQuery = await resolveExpandedCorpusQuery({
    build: (expand) =>
      caseLawCorpusQuery(
        query.query,
        {
          court: query.court,
          dateFrom: query.dateFrom,
          dateTo: query.dateTo,
          documentType: query.documentType,
          language: query.language,
          source: query.source,
        },
        expand,
      ),
    jurisdiction: query.jurisdiction,
    mode: envBase.QUERY_EXPANSION_MODE,
    text: query.query,
  });
  if (engineQuery === null) {
    return { hits: [], facets: null, nextCursor: null, limit };
  }

  // Upper bound for the pagination early-stop: scanning may end only
  // once no unseen candidate could out-blend the page cursor.
  const [authorityBound] = await caseLawPublicReadDb((tx) =>
    tx
      .select({
        max: sql<number>`coalesce(max(${caseLawDecisions.citationAuthority}), 0)`,
      })
      .from(caseLawDecisions),
  );
  const maxAuthority = authorityBound?.max ?? 0;

  const searchPage = await readCorpusIndexSearchPage({
    indexId,
    query: engineQuery,
    limit,
    parsedCursor,
    snippetFields: ["text"],
    extractId: (hit) => {
      const id = hit["document_id"];
      return typeof id === "string" && isUuid(id) ? id : null;
    },
    extractSnippet,
    unseenScoreUpperBound: (nextLexicalScore) =>
      stableBlendUpperBound(nextLexicalScore, maxAuthority),
    rankCandidates: async (candidates) => {
      const ids = candidates.map((candidate) =>
        toSafeId<"caseLawDecision">(candidate.id),
      );
      const rows =
        ids.length === 0
          ? []
          : await caseLawPublicReadDb((tx) =>
              tx
                .select({
                  id: caseLawDecisions.id,
                  caseNumber: caseLawDecisions.caseNumber,
                  ecli: caseLawDecisions.ecli,
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
                // Same gates as the public search rehydration: source
                // policy, and only rows whose index state is current.
                .where(
                  and(
                    inArray(caseLawDecisions.id, ids),
                    redistributableCaseLawSource,
                    currentCaseLawCorpusProjection(generation),
                  ),
                ),
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
    hasMore,
    pageRanked,
    passageCountById,
    snippetById,
  } = searchPage;

  const last = pageRanked.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.score, last.id) : null;

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
  getDocumentContext: loadDocumentContext,
};
