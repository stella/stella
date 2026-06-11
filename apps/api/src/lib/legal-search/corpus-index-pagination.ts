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
  /**
   * Highest blended score any unseen candidate could still reach, given
   * the next rank's lexical score. The scan continues past a full page
   * until this drops below the would-be cursor, so reranking cannot
   * promote an unseen candidate past an emitted page.
   */
  unseenScoreUpperBound: (nextLexicalScore: number) => number;
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
  unseenScoreUpperBound,
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
      const cursorScore = windowed.at(limit - 1)?.score ?? 0;
      const nextUnseen = unseenScoreUpperBound(
        corpusIndexLexicalScore(totalHits, startOffset),
      );
      if (nextUnseen < cursorScore) {
        break;
      }
    }
  }

  if (ranking === null) {
    ranking = await rankCandidates(candidates);
    windowed = windowAfterCursor(ranking.ranked, parsedCursor);
  }

  const hasMoreInWindow = windowed.length > limit;
  const pageRanked = hasMoreInWindow ? windowed.slice(0, limit) : windowed;
  // A follow-up request rescans from offset 0 and can only reach deeper
  // candidates while the scan cap is not exhausted; past the cap a
  // cursor could never be satisfied and must not be advertised.
  const scanCanContinue =
    startOffset < totalHits && startOffset < LIMITS.corpusIndexSearchScanLimit;
  const hasMore = hasMoreInWindow || (scanCanContinue && pageRanked.length > 0);

  return {
    pageRanked,
    context: ranking.context,
    snippetById,
    hasMore,
  };
};
