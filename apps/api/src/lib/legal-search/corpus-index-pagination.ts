import type { QuickwitCluster } from "@/api/lib/legal-search/corpus-generation-contract";
import type { CorpusIndexHit } from "@/api/lib/legal-search/corpus-index-client";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import type { RankedHit, ScoredCandidate } from "@/api/lib/legal-search/rerank";
import { LIMITS } from "@/api/lib/limits";
import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";

export type SearchCursor = {
  score: number;
  id: string;
  /**
   * Rank the scan behind this cursor began at. A scan that proved its own
   * stop bound leaves the window where it is, and the continuation replays it
   * from the same rank: replaying is what keeps a document ranked by its best
   * passage, because every passage of it is scanned again. A scan stopped by
   * the round cap proved nothing, so it hands the next request the rank it
   * reached and the window moves on.
   */
  windowStart: number;
};

/**
 * The cursor as the client sees it: the shared `score:id` payload with the
 * window the scan must resume in folded into the id half. A payload without a
 * window prefix names window 0, which is what a cursor issued before windows
 * existed means and what a caller building one by hand should get.
 */
export const encodeCorpusIndexCursor = ({
  score,
  id,
  windowStart,
}: SearchCursor): string => encodeCursor(score, `${windowStart}:${id}`);

export const decodeCorpusIndexCursor = (
  cursor: string,
): SearchCursor | null => {
  const decoded = decodeCursor(cursor);
  if (decoded === null) {
    return null;
  }
  const separatorIndex = decoded.id.indexOf(":");
  if (separatorIndex === -1) {
    return { ...decoded, windowStart: 0 };
  }
  const windowStart = Number(decoded.id.slice(0, separatorIndex));
  const id = decoded.id.slice(separatorIndex + 1);
  if (!Number.isInteger(windowStart) || windowStart < 0 || id.length === 0) {
    return null;
  }
  return { score: decoded.score, id, windowStart };
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
   * How many passages of a document matched, within the scanned window. A
   * breadth signal — one paragraph on point versus a document that discusses
   * the topic throughout. Reported, not folded into `score`: the count grows
   * as the scan widens, and a score that changes between windows would break
   * the keyset cursor, which assumes an already-emitted hit keeps the score it
   * was emitted with.
   */
  passageCountById: Map<string, number>;
  /** Where the next page resumes, or null when this page is the last. */
  nextCursor: SearchCursor | null;
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

/**
 * Lexical score of the hit at `globalIndex` in the engine's `_score` order.
 * The engine reports the order but not the scores, so the rank stands in for
 * them, decaying by a factor of e per round of candidates:
 *
 *   lexical(i) = exp(-i / corpusIndexSearchCandidateLimit)
 *
 * Two properties matter. It is strictly decreasing, so the early-stop proof
 * holds unchanged: once `unseenScoreUpperBound(lexical(next))` falls below the
 * page's last blended score, no unseen hit can out-blend an emitted one. And
 * it reads only the rank, so a rescan for page two assigns an already-emitted
 * hit exactly the score its cursor encodes — the previous form divided by the
 * index-wide hit count, which drifts as the corpus changes.
 *
 * What it means for ranking: an additive signal of total weight `w` can lift a
 * candidate over a hit whose lexical score is `s` only while
 * `s - w < lexical(candidate)`, so it reaches at most
 * `candidateLimit × ln(1 / (s - w))` ranks above itself. Citation authority
 * therefore re-orders within a window of the top few hundred hits rather than
 * across the whole list, which is the intended definition: the engine's order
 * is the primary key and the blend re-orders a bounded window of it.
 */
export const corpusIndexLexicalScore = (globalIndex: number): number =>
  Math.exp(-globalIndex / LIMITS.corpusIndexSearchCandidateLimit);

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
  // Absolute rank in the engine's order, so a hit keeps the score its cursor
  // encodes whichever window reached it; `scanned` is this request's own work,
  // which is what the budget and the telemetry are about.
  const windowStart = parsedCursor?.windowStart ?? 0;
  let startOffset = windowStart;
  let scanned = 0;
  /** Document owning the last passage the scan read; the next window's edge. */
  let lastScannedId: string | null = null;
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
    const perDocument = Math.min(scanned / resultUnits, PASSAGE_OVER_FETCH);
    return Math.ceil(
      LIMITS.corpusIndexSearchScanLimit * Math.max(1, perDocument),
    );
  };

  while (startOffset < totalHits && scanned < scanBudget()) {
    // Every round is one more sequential engine round trip in front of the
    // reader. The budget above bounds how many candidates a scan may reach;
    // this bounds how long it may take to give up trying.
    if (rounds >= LIMITS.corpusIndexSearchMaxRounds) {
      roundCapHit = true;
      break;
    }

    const maxHits = Math.min(
      LIMITS.corpusIndexSearchCandidateLimit,
      scanBudget() - scanned,
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
      lastScannedId = id;
      // The cursor names a hit the reader already has. Its remaining passages
      // are a continuation of that hit, not a new one — which is what a window
      // opening in the middle of a long document's passages returns, and the
      // score filter below cannot catch, because in a fresh window those
      // passages score below the cursor rather than above it.
      if (id === parsedCursor?.id) {
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
        score: corpusIndexLexicalScore(startOffset + index),
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
    scanned += hits.length;
    // oxlint-disable-next-line no-await-in-loop -- ranks the accumulated candidates each round to decide whether to stop early
    ranking = await rankCandidates(candidates);
    windowed = windowAfterCursor(ranking.ranked, parsedCursor);
    if (windowed.length > limit) {
      const cursorScore = windowed.at(limit - 1)?.score ?? 0;
      const nextUnseen = unseenScoreUpperBound(
        corpusIndexLexicalScore(startOffset),
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
  const lastEmitted = pageRanked.at(-1);
  // A follow-up request replays this window and can only reach deeper
  // candidates while the window's own budget is not exhausted; past it a
  // cursor could never be satisfied and must not be advertised.
  const windowCanContinue = startOffset < totalHits && scanned < scanBudget();
  // The window itself moves only when the round cap ended the scan. The cap
  // is what makes a page bounded-latency, and it is also why such a page
  // cannot prove the blend bound the early stop proves: an unemitted hit in
  // the next window may out-blend one this page emitted. Progress is worth
  // more than that proof — a decision whose passages fill the whole capped
  // window would otherwise leave the reader on a one-hit page with nowhere to
  // go, and there is no ceiling on passages per document that the cap could
  // be sized above (the chunker's is a hostile-input bound, orders of
  // magnitude higher).
  const resolveNextCursor = (): SearchCursor | null => {
    if (lastEmitted === undefined) {
      return null;
    }
    if (hasMoreInWindow || (!roundCapHit && windowCanContinue)) {
      return { score: lastEmitted.score, id: lastEmitted.id, windowStart };
    }
    if (!roundCapHit || startOffset >= totalHits) {
      return null;
    }
    return {
      // Above every blended score the next window can hold, by the bound's
      // own contract, so none of that window is filtered out as already seen.
      score: unseenScoreUpperBound(corpusIndexLexicalScore(startOffset)),
      // The document the scan stopped inside: the one whose passages can run
      // across the window edge, and the only one the next window must drop by
      // name. Everything else this window held was emitted (the window moves
      // only once its whole ranking fit on a page), so a document that matched
      // here and again further down can still repeat on a later page — the
      // price of moving the window at all, and the reason the blend bound is
      // proven within a window rather than across the cap.
      id: lastScannedId ?? lastEmitted.id,
      windowStart: startOffset,
    };
  };
  const nextCursor = resolveNextCursor();

  return {
    pageRanked,
    context: ranking.context,
    snippetById,
    anchorIdById,
    passageCountById,
    nextCursor,
    scan: {
      rounds,
      passagesScanned: scanned,
      indexMs,
      earlyStopped,
      roundCapHit,
    },
  };
};
