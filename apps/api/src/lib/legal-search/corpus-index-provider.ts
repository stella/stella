import { and, eq, inArray, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { redistributableCaseLawSource } from "@/api/handlers/case-law/redistribution";
// eslint-disable-next-line no-restricted-imports -- search boundary: brands document ids returned by the corpus index before re-hydrating from Postgres
import { toSafeId } from "@/api/lib/branded-types";
import { isUuid } from "@/api/lib/custom-schema";
import { corpusGeneration } from "@/api/lib/legal-search/corpus-family";
import { readCorpusIndexSearchPage } from "@/api/lib/legal-search/corpus-index-pagination";
import { loadDocumentContext } from "@/api/lib/legal-search/document-context";
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
 */

const toNullableString = (x: unknown): string | null =>
  x === null ? null : JSON.stringify(x);

const quote = (value: string): string => `"${value.replaceAll('"', '\\"')}"`;

const buildQuery = (query: LegalSearchQuery): string => {
  // jurisdiction is not a query clause — it selects the index (one index
  // per jurisdiction), so a scoped query only touches that index.
  const clauses: string[] = [`(${query.query})`];
  if (query.documentType) {
    clauses.push(`document_type:${quote(query.documentType)}`);
  }
  if (query.source) {
    clauses.push(`source:${quote(query.source)}`);
  }
  if (query.language) {
    clauses.push(`language:${quote(query.language)}`);
  }
  if (query.court) {
    clauses.push(`court:${quote(query.court)}`);
  }
  if (query.dateFrom || query.dateTo) {
    const from = query.dateFrom ?? "*";
    const to = query.dateTo ?? "*";
    clauses.push(`decision_date:[${from} TO ${to}]`);
  }
  return clauses.join(" AND ");
};

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

  // Upper bound for the pagination early-stop: scanning may end only
  // once no unseen candidate could out-blend the page cursor.
  const [authorityBound] = await rootDb
    .select({
      max: sql<number>`coalesce(max(${caseLawDecisions.citationAuthority}), 0)`,
    })
    .from(caseLawDecisions);
  const maxAuthority = authorityBound?.max ?? 0;

  const searchPage = await readCorpusIndexSearchPage({
    indexId,
    query: buildQuery(query),
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
          : await rootDb
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
                  eq(
                    caseLawDecisions.indexedHash,
                    caseLawDecisions.contentHash,
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
    context: { displayById },
    hasMore,
    pageRanked,
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
