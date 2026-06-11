import type { CorpusIndexHit } from "@/api/lib/legal-search/corpus-index-client";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import type { RankedHit, ScoredCandidate } from "@/api/lib/legal-search/rerank";
import { LIMITS } from "@/api/lib/limits";

export type SearchCursor = {
  score: number;
  id: string;
};

type CorpusIndexRanking<TContext> = {
  ranked: readonly RankedHit[];
  context: TContext;
};

type CorpusIndexSearchPageInput<TContext> = {
  indexId: string;
  query: string;
  limit: number;
  parsedCursor: SearchCursor | null;
  snippetFields: string[];
  extractId: (hit: CorpusIndexHit) => string | null;
  extractSnippet: (
    snippet: Record<string, unknown> | undefined,
  ) => string | null;
  rankCandidates: (
    candidates: readonly ScoredCandidate[],
  ) => Promise<CorpusIndexRanking<TContext>>;
};

type CorpusIndexSearchPageResult<TContext> = {
  pageRanked: RankedHit[];
  context: TContext;
  snippetById: Map<string, string>;
  hasMore: boolean;
};

export const isAfterSearchCursor = (
  hit: { score: number; id: string },
  cursor: SearchCursor,
): boolean => {
  if (hit.score < cursor.score) {
    return true;
  }
  if (hit.score > cursor.score) {
    return false;
  }
  return hit.id < cursor.id;
};

export const corpusIndexLexicalScore = (
  totalHits: number,
  globalIndex: number,
): number => {
  const denominator = Math.max(1, totalHits - 1);
  return Math.max(0, 1 - globalIndex / denominator);
};

const windowAfterCursor = (
  ranked: readonly RankedHit[],
  parsedCursor: SearchCursor | null,
): RankedHit[] =>
  parsedCursor === null
    ? [...ranked]
    : ranked.filter((hit) => isAfterSearchCursor(hit, parsedCursor));

export const readCorpusIndexSearchPage = async <TContext>({
  indexId,
  query,
  limit,
  parsedCursor,
  snippetFields,
  extractId,
  extractSnippet,
  rankCandidates,
}: CorpusIndexSearchPageInput<TContext>): Promise<
  CorpusIndexSearchPageResult<TContext>
> => {
  const candidates: ScoredCandidate[] = [];
  const snippetById = new Map<string, string>();
  const seenIds = new Set<string>();
  let ranking: CorpusIndexRanking<TContext> | null = null;
  let windowed: RankedHit[] = [];
  let startOffset = 0;
  let totalHits = Number.POSITIVE_INFINITY;

  while (
    startOffset < totalHits &&
    startOffset < LIMITS.corpusIndexSearchScanLimit
  ) {
    const maxHits = Math.min(
      LIMITS.corpusIndexSearchCandidateLimit,
      LIMITS.corpusIndexSearchScanLimit - startOffset,
    );
    if (maxHits <= 0) {
      break;
    }

    // Sort by BM25 explicitly: without it the engine returns hits in
    // document-id order and the rank-based lexical score below would be
    // meaningless.
    const result = await getCorpusIndexClient().search({
      indexId,
      query,
      maxHits,
      startOffset,
      sortBy: "_score",
      snippetFields,
    });
    if (result.isErr()) {
      throw result.error;
    }

    const hits = result.value.hits;
    if (hits.length === 0) {
      totalHits = result.value.numHits;
      break;
    }

    totalHits = Math.max(result.value.numHits, startOffset + hits.length);
    for (const [index, hit] of hits.entries()) {
      const id = extractId(hit);
      if (id === null || seenIds.has(id)) {
        continue;
      }

      seenIds.add(id);
      candidates.push({
        id,
        score: corpusIndexLexicalScore(totalHits, startOffset + index),
      });

      const snippet = extractSnippet(result.value.snippets[index]);
      if (snippet !== null) {
        snippetById.set(id, snippet);
      }
    }

    startOffset += hits.length;
    ranking = await rankCandidates(candidates);
    windowed = windowAfterCursor(ranking.ranked, parsedCursor);
    if (windowed.length > limit) {
      break;
    }
  }

  if (ranking === null) {
    ranking = await rankCandidates(candidates);
    windowed = windowAfterCursor(ranking.ranked, parsedCursor);
  }

  const hasMoreInWindow = windowed.length > limit;
  const pageRanked = hasMoreInWindow ? windowed.slice(0, limit) : windowed;
  const hitScanLimit = startOffset < totalHits;
  const hasMore = hasMoreInWindow || (hitScanLimit && pageRanked.length > 0);

  return {
    pageRanked,
    context: ranking.context,
    snippetById,
    hasMore,
  };
};
