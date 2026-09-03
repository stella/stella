import type { QuickwitCluster } from "@/api/lib/legal-search/corpus-generation-contract";
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
  cluster: QuickwitCluster;
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
  /**
   * Deep-link anchor of the best-scoring passage per document. Absent for
   * documents indexed whole, and for passages the fallback chunker produced
   * from unstructured text (there is no block to anchor to).
   */
  anchorIdById: Map<string, string>;
  /**
   * How many passages of a document matched. A breadth signal — one paragraph
   * on point versus a document that discusses the topic throughout. Reported,
   * not folded into `score`: the count grows as the scan widens, and a score
   * that changes between windows would break the keyset cursor, which assumes
   * an already-emitted hit keeps the score it was emitted with.
   */
  passageCountById: Map<string, number>;
  hasMore: boolean;
  /** What the scan spent reaching this page, and why it stopped. */
  scan: CorpusIndexScanReport;
};

/**
 * The cost of one scan. A response looks the same whether it took one engine
 * round trip or the cap's worth, so the count is only observable if the scan
 * reports it.
 */
export type CorpusIndexScanReport = {
  /** Engine round trips spent accumulating candidates. */
  rounds: number;
  /** Hits the engine returned across those rounds. */
  passagesScanned: number;
  /** Summed wall time of those engine calls. */
  indexMs: number;
  /** Stopped because no unseen candidate could out-blend the page. */
  earlyStopped: boolean;
  /** Stopped at `LIMITS.corpusIndexSearchMaxRounds` instead. */
  roundCapHit: boolean;
};

/** What a request that never reached the index spent on it. */
export const emptyCorpusIndexScan = (): CorpusIndexScanReport => ({
  rounds: 0,
  passagesScanned: 0,
  indexMs: 0,
  earlyStopped: false,
  roundCapHit: false,
});

/**
 * Passage-layout indexes return several hits per document, so a fixed
 * chunk-space scan budget would reach proportionally fewer documents than the
 * same budget did when one document was one hit — and a cursor can only point
 * at a document the scan can reach again. The budget is therefore scaled by
 * the passages-per-document ratio the scan actually observes: 1.0 on a
 * document-layout index (unchanged behavior, no extra requests), rising to at
 * most this factor on a passage-layout one. The cap is what bounds the extra
 * engine work; a document whose matching passages exceed it simply consumes
 * more of the budget than its share.
 *
 * It bounds candidates, not requests: what the reader waits through is the
 * number of sequential engine round trips, which
 * `LIMITS.corpusIndexSearchMaxRounds` bounds independently of how wide this
 * factor lets the budget grow.
 */
const PASSAGE_OVER_FETCH = 4;

const readAnchorId = (hit: CorpusIndexHit): string | null => {
  const anchorId = hit["anchor_id"];
  return typeof anchorId === "string" && anchorId.length > 0 ? anchorId : null;
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
  cluster,
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
  const anchorIdById = new Map<string, string>();
  const passageCountById = new Map<string, number>();
  let ranking: CorpusIndexRanking<TContext> | null = null;
  let windowed: RankedHit[] = [];
  let startOffset = 0;
  let totalHits = Number.POSITIVE_INFINITY;
  let rounds = 0;
  let roundCapHit = false;
  let earlyStopped = false;
  let indexMs = 0;

  // Chunk-space scan budget, grown to keep result-space reach constant
  // across index layouts. Recomputed each round from what the scan has seen so
  // far, so it costs nothing until an index actually returns several passages
  // per document. Once a ranking exists, the unit is what the ranker emits:
  // candidates it folded together (the language versions of one decision)
  // consumed scan budget the same way extra passages did.
  const scanBudget = (): number => {
    const resultUnits =
      ranking === null
        ? passageCountById.size
        : Math.max(1, ranking.ranked.length);
    if (resultUnits === 0) {
      return LIMITS.corpusIndexSearchScanLimit;
    }
    const perDocument = Math.min(startOffset / resultUnits, PASSAGE_OVER_FETCH);
    return Math.ceil(
      LIMITS.corpusIndexSearchScanLimit * Math.max(1, perDocument),
    );
  };

  while (startOffset < totalHits && startOffset < scanBudget()) {
    // Every round is one more sequential engine round trip in front of the
    // reader. The budget above bounds how many candidates a scan may reach;
    // this bounds how long it may take to give up trying.
    if (rounds >= LIMITS.corpusIndexSearchMaxRounds) {
      roundCapHit = true;
      break;
    }

    const maxHits = Math.min(
      LIMITS.corpusIndexSearchCandidateLimit,
      scanBudget() - startOffset,
    );
    if (maxHits <= 0) {
      break;
    }
    rounds += 1;

    // Sort by BM25 explicitly: without it the engine returns hits in
    // document-id order and the rank-based lexical score below would be
    // meaningless.
    const roundStartedAt = performance.now();
    // oxlint-disable-next-line no-await-in-loop -- offset pagination: each scan depends on the previous startOffset
    const result = await getCorpusIndexClient(cluster).search({
      indexId,
      query,
      maxHits,
      startOffset,
      sortBy: "_score",
      snippetFields,
    });
    indexMs += performance.now() - roundStartedAt;
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
      if (id === null) {
        continue;
      }

      // Hits arrive best-first, so the first hit seen for a document is its
      // best-scoring passage: it sets the document's rank, its snippet, and
      // the anchor the result deep-links to. Later passages of the same
      // document only add to its breadth count.
      const seen = passageCountById.get(id);
      if (seen !== undefined) {
        passageCountById.set(id, seen + 1);
        continue;
      }
      passageCountById.set(id, 1);

      candidates.push({
        id,
        score: corpusIndexLexicalScore(totalHits, startOffset + index),
      });

      const snippet = extractSnippet(result.value.snippets[index]);
      if (snippet !== null) {
        snippetById.set(id, snippet);
      }
      const anchorId = readAnchorId(hit);
      if (anchorId !== null) {
        anchorIdById.set(id, anchorId);
      }
    }

    startOffset += hits.length;
    // oxlint-disable-next-line no-await-in-loop -- ranks the accumulated candidates each round to decide whether to stop early
    ranking = await rankCandidates(candidates);
    windowed = windowAfterCursor(ranking.ranked, parsedCursor);
    if (windowed.length > limit) {
      const cursorScore = windowed.at(limit - 1)?.score ?? 0;
      const nextUnseen = unseenScoreUpperBound(
        corpusIndexLexicalScore(totalHits, startOffset),
      );
      if (nextUnseen < cursorScore) {
        earlyStopped = true;
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
  // cursor could never be satisfied and must not be advertised. The round
  // cap binds the same way: a rescan spends the same rounds and stops at the
  // same offset, so nothing past it is reachable by paging.
  const scanCanContinue =
    !roundCapHit && startOffset < totalHits && startOffset < scanBudget();
  const hasMore = hasMoreInWindow || (scanCanContinue && pageRanked.length > 0);

  return {
    pageRanked,
    context: ranking.context,
    snippetById,
    anchorIdById,
    passageCountById,
    hasMore,
    scan: {
      rounds,
      passagesScanned: startOffset,
      indexMs,
      earlyStopped,
      roundCapHit,
    },
  };
};
