import { inArray } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { caseLawDecisions } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { corpusGeneration } from "@/api/lib/legal-search/corpus-family";
import { loadDocumentContext } from "@/api/lib/legal-search/document-context";
import {
  corpusIndexId,
  corpusIndexPattern,
} from "@/api/lib/legal-search/index-naming";
import { getQuickwitClient } from "@/api/lib/legal-search/quickwit-client";
import {
  blendCitationAuthority,
  type ScoredCandidate,
} from "@/api/lib/legal-search/rerank";
import type {
  LegalSearchHit,
  LegalSearchProvider,
  LegalSearchQuery,
  LegalSearchResult,
} from "@/api/lib/legal-search/types";
import { LIMITS } from "@/api/lib/limits";
import { encodeCursor, decodeCursor } from "@/api/lib/search/cursor";

/**
 * Quickwit legal-search provider: two-stage retrieve-then-rerank.
 * Quickwit returns BM25 lexical candidates (filtered by tag/fast fields
 * for split pruning); the API re-joins them to the precomputed
 * citation_authority in Postgres and blends via RRF — Quickwit has no
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
  // Quickwit wraps matched terms in <b>; the UI renders <mark>. Quickwit
  // escapes the surrounding text, so this swap is safe. Aligning fully
  // with the pg ts_headline pipeline is a follow-up.
  return raw.replaceAll("<b>", "<mark>").replaceAll("</b>", "</mark>");
};

const afterCursor = (
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

const search = async (query: LegalSearchQuery): Promise<LegalSearchResult> => {
  const limit = query.limit;
  const generation = corpusGeneration(query.documentFamily ?? "case_law");

  // Scoped query → that jurisdiction's index; unscoped → the generation
  // glob (Quickwit multi-index search across all jurisdiction indexes).
  const indexId = query.jurisdiction
    ? corpusIndexId(generation, query.jurisdiction)
    : corpusIndexPattern(generation);

  const result = await getQuickwitClient().search({
    indexId,
    query: buildQuery(query),
    maxHits: LIMITS.quickwitSearchCandidateLimit,
    snippetFields: ["text"],
  });
  if (result.isErr()) {
    throw result.error;
  }

  const candidates: ScoredCandidate[] = [];
  const snippetById = new Map<string, string>();
  result.value.hits.forEach((hit, index) => {
    const id = hit["document_id"];
    if (typeof id !== "string") {
      return;
    }
    // Descending pseudo-score preserves Quickwit's BM25 ordering as the
    // lexical signal for the blend (absolute BM25 values aren't needed).
    candidates.push({ id, score: result.value.hits.length - index });
    const snippet = extractSnippet(result.value.snippets[index]);
    if (snippet !== null) {
      snippetById.set(id, snippet);
    }
  });

  const ids = candidates.map((c) => toSafeId<"caseLawDecision">(c.id));
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
          .where(inArray(caseLawDecisions.id, ids));

  // Keyed by plain string id (candidate ids from Quickwit are strings).
  const displayById = new Map(rows.map((row) => [String(row.id), row]));
  const authorityById = new Map(
    rows.map((row) => [String(row.id), row.citationAuthority]),
  );

  // Drop candidates missing from Postgres (index/DB drift) so we never
  // surface a hit we cannot render.
  const ranked = blendCitationAuthority({
    candidates: candidates.filter((c) => displayById.has(c.id)),
    authorityById,
  });

  const parsedCursor = query.cursor ? decodeCursor(query.cursor) : null;
  const windowed = parsedCursor
    ? ranked.filter((hit) => afterCursor(hit, parsedCursor))
    : ranked;
  const hasMore = windowed.length > limit;
  const pageRanked = hasMore ? windowed.slice(0, limit) : windowed;

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

  // Exact facet counts over broad queries are expensive in Quickwit; the
  // shipped UI already tolerates null facets (returned on paginated
  // pages). Quickwit aggregations are a follow-up.
  return { hits, facets: null, nextCursor, limit };
};

export const quickwitLegalProvider: LegalSearchProvider = {
  search,
  getDocumentContext: loadDocumentContext,
};
