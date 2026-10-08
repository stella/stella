import { panic } from "better-result";

import {
  SEARCH_PAGE_REACH,
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET,
  type SearchPageReach,
  type SearchPaginationOutcome,
} from "@stll/api-contract/search";
import type { RegistryRequestObservation } from "@stll/business-registries/shared/request-observer";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { QuickwitCluster } from "@/api/lib/legal-search/corpus-generation-contract";
import { classifyCorpusHit } from "@/api/lib/legal-search/corpus-hit-disposition";
import {
  createCorpusHitDispositionCounter,
  reportCorpusHitDispositions,
  type CorpusHitDispositionCounter,
} from "@/api/lib/legal-search/corpus-hit-telemetry";
import type {
  CorpusIndexError,
  CorpusIndexHit,
  CorpusIndexScoredSearchResponse,
} from "@/api/lib/legal-search/corpus-index-client";
import {
  getCorpusIndexClient,
  isCorpusIndexUnreachable,
} from "@/api/lib/legal-search/corpus-index-client";
import { quoteCorpusValue } from "@/api/lib/legal-search/corpus-query";
import {
  CORPUS_BM25_PASSAGE_LIMIT,
  CORPUS_BM25_RATIO_POWER,
  type CorpusIndexRankingMode,
} from "@/api/lib/legal-search/corpus-ranking-policy";
import {
  type CorpusSearchOrder,
  corpusEngineSortBy,
  type SearchSort,
} from "@/api/lib/legal-search/corpus-search-order";
import type { RankedHit, ScoredCandidate } from "@/api/lib/legal-search/rerank";
import { searchIndexUnavailableError } from "@/api/lib/legal-search/search-index-unavailable";
import { LIMITS } from "@/api/lib/limits";

/**
 * The client answers a failed search with a typed `CorpusIndexError` so its
 * caller can say what the failure was. Re-throwing that value raw spends the
 * classification: no search handler catches `CorpusIndexError`, so the handler
 * boundary grades it `UnhandledException` and answers 500, telling a reader
 * the API broke when the engine is the thing that could not answer.
 *
 * The engine reports its own overload as a 5xx rather than a 429, so status
 * alone cannot separate "busy" from "broken". Both are the caller's cue to
 * retry, which is what 503 says; a 4xx means this module built a request the
 * engine refused, which no retry fixes and 502 reports. Mapping matches
 * `catalogueUpstreamStatus`, the same translation for the skill catalogue.
 * An engine that could not be reached at all answers with the typed
 * `search_index_unavailable` refusal, which every search route and tool maps
 * to the same actionable answer.
 */
const corpusIndexSearchFailure = (error: CorpusIndexError): HandlerError =>
  isCorpusIndexUnreachable(error)
    ? searchIndexUnavailableError(error)
    : new HandlerError({
        status:
          error.status === undefined ||
          error.status === 429 ||
          error.status >= 500
            ? 503
            : 502,
        message: "Search is temporarily unavailable",
        cause: error,
      });

/**
 * A page boundary as the scan means it. `corpus-search-cursor` owns how it
 * reaches a client and back, together with the dictionary the ranked query was
 * built against: what the scan needs and what expansion needs are one string
 * on the wire, and one codec answers for it.
 */
export type SearchCursor = {
  score: number;
  id: string;
  /** Effective experiment mode; absent on existing position cursors. */
  rankingMode?: CorpusIndexRankingMode;
  /**
   * Order the scan behind this cursor ran in. The boundary below is a
   * position in that order and means nothing in another one, so a
   * continuation that changed the order is refused rather than resumed.
   */
  sort: SearchSort;
  /**
   * Rank the scan behind this cursor began at. A scan that proved its own
   * stop bound leaves the window where it is, and the continuation replays it
   * from the same rank: replaying is what keeps a document ranked by its best
   * passage, because every passage of it is scanned again. A scan stopped by
   * the round cap proved nothing, so it hands the next request the rank it
   * reached and the window moves on.
   */
  windowStart: number;
  /**
   * Groups a ranker folds its hits into (`CorpusIndexRanking.groups`) that
   * earlier windows already showed. A window move hands them on, because a
   * group's deeper member in the next window would otherwise show it again;
   * the ranker leaves them out. Proven singletons need no token.
   * Absent before any window has moved.
   */
  excludedGroups?: readonly string[] | undefined;
};

type CorpusIndexRanking<TContext> = {
  ranked: readonly RankedHit[];
  context: TContext;
  /**
   * Tokens of emitted units that may recur beyond this window, including any
   * cursor group the ranker omits, for a continuation into the next window.
   * Rankers must exclude tokens carried in `SearchCursor.excludedGroups`.
   */
  groups: readonly string[];
};

/**
 * What the ranker must leave out of a ranking: the groups earlier windows of
 * the chain already showed (`SearchCursor.excludedGroups`). Handed to the
 * ranker with every call rather than closed over from the request, because a
 * page addressed by offset walks windows the request's own cursor never
 * named.
 */
type CorpusIndexRankingScope = {
  excludedGroups: ReadonlySet<string>;
};

const rankingScopeOf = (
  cursor: SearchCursor | null,
): CorpusIndexRankingScope => ({
  excludedGroups: new Set(cursor?.excludedGroups),
});

/**
 * Where the scan reads its rounds from. Both return the engine's `_score`
 * order for the same query string. Position ranking reads the rank; the
 * experimental BM25 ranking requires the scored transport.
 *
 * - `native`: the engine's own search endpoint. A hit is the whole stored
 *   document, passage text included.
 * - `scored`: the ES-compatible endpoint, projected to the fields the scan
 *   reads (`fields`, plus the passage fields below), with each hit's BM25
 *   beside it. Relevance order only: a score says nothing about a date order.
 */
export type CorpusIndexScanTransport =
  | { type: "native" }
  | { type: "scored"; fields: readonly string[] };

export const NATIVE_SCAN_TRANSPORT = {
  type: "native",
} as const satisfies CorpusIndexScanTransport;

/** Fields the scan itself reads off a hit, whatever the caller's id is. */
const CORPUS_INDEX_SCAN_PASSAGE_FIELDS = [
  "document_id",
  "chunk_id",
  "anchor_id",
] as const;

type CorpusIndexSearchPageInput<TContext> = {
  /** Caller-owned counters join this page's counts to the request's existing observation. */
  hitDispositions?: CorpusHitDispositionCounter | undefined;
  observer: RegistryRequestObservation;
  cluster: QuickwitCluster;
  indexId: string;
  query: string;
  limit: number;
  parsedCursor: SearchCursor | null;
  /**
   * Results of the cursor chain a page addressed by number passes over before
   * its first row. Only a page without a cursor has one: a cursor already
   * says where the page begins. Absent for every other page.
   */
  skip?: number | undefined;
  /** Defaults to `native`. */
  scanTransport?: CorpusIndexScanTransport | undefined;
  /** A coverage fallback spends one scan round; only emitted hits are highlighted. */
  maxRounds?: number | undefined;
  /**
   * Order the engine returns candidates in, and with it the meaning of the
   * position score below. Required rather than defaulted: the cursor carries
   * the order, so a caller that did not choose one cannot page correctly.
   */
  order: CorpusSearchOrder;
  /** Fixed-window BM25 experiment; the default preserves the position scan. */
  rankingMode?: CorpusIndexRankingMode;
  /** Main transport to restore when the experiment falls back. */
  fallbackScanTransport?: CorpusIndexScanTransport;
  /**
   * Fields the engine highlights. Requested for the passages the page emits
   * and never for the scan: highlighting is per-hit work, and a scan reaches
   * a couple of hundred passages to answer with ten.
   */
  snippetFields: string[];
  extractId: (hit: CorpusIndexHit) => string | null;
  /**
   * The excerpt one hit shows. Handed the hit beside its snippet because the
   * engine's snippet is a fixed width with no size on the wire: a caller that
   * wants a wider one cuts it from the hit's own stored passage, which costs
   * no further read.
   */
  extractSnippet: (
    snippet: Record<string, unknown> | undefined,
    hit: CorpusIndexHit,
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
    scope: CorpusIndexRankingScope,
  ) => Promise<CorpusIndexRanking<TContext>>;
};

type ObservedCorpusIndexSearchPageInput<TContext> =
  CorpusIndexSearchPageInput<TContext> & {
    hitDispositions: CorpusHitDispositionCounter;
  };

type CorpusIndexSearchPageResult<TContext> = ScanPage<TContext> & {
  /**
   * Whether the scan placed the page: `scan_budget` when a page addressed by
   * offset ran out of windows before the cursor chain reached it. Such a page
   * carries no cursor and ends nothing.
   */
  reach: SearchPageReach;
};

/** What one reader's scan produced, before the page's reach is judged. */
type ScanPage<TContext> = {
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
  /** Clause addressing each document's best passage (see `passageClause`). */
  passageClauseById: Map<string, string>;
  /** Where the next page resumes; null on exhaustion or explicit truncation. */
  nextCursor: SearchCursor | null;
  paginationOutcome: SearchPaginationOutcome;
  /** What the scan spent reaching this page, and why it stopped. */
  scan: CorpusIndexScanReport;
  /** The scores the scan read, under the `scored` transport; null otherwise. */
  lexicalScores: CorpusIndexScanScores | null;
};

/**
 * BM25 as the engine reported it for what one scan read. Position ranking
 * keeps this as diagnostic evidence; the experimental ranking uses these
 * scores directly, normalized against the first passage.
 */
type CorpusIndexScanScores = {
  /**
   * BM25 of the query's first hit. Null when the window began past it (a
   * continuation) or nothing matched.
   */
  topScore: number | null;
  /** Best passage's BM25 per document, in the order the scan reached them. */
  bestScoreById: ReadonlyMap<string, number>;
  /** Clause addressing each document's best passage (see `passageClause`). */
  passageClauseById: ReadonlyMap<string, string>;
  /** Rank of the first hit the scan did not read. */
  nextOffset: number;
  /** The query's hit count as the engine last reported it. */
  totalHits: number;
  /** BM25 of the last hit read; no unread hit scores above it. */
  lastScore: number | null;
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
  /** Summed wall time of every engine call the read made. */
  indexMs: number;
  /** Stopped because no unseen candidate could out-blend the page. */
  earlyStopped: boolean;
  /** Stopped at `LIMITS.corpusIndexSearchMaxRounds` instead. */
  roundCapHit: boolean;
  /**
   * Engine round trips spent highlighting the page: one, or none when the
   * page is empty. Separate from `rounds` because it reaches a page's worth
   * of passages rather than the scan's, and a reader waits through both.
   */
  highlightRounds: number;
};

/** What a request that never reached the index spent on it. */
export const emptyCorpusIndexScan = (): CorpusIndexScanReport => ({
  rounds: 0,
  passagesScanned: 0,
  indexMs: 0,
  earlyStopped: false,
  roundCapHit: false,
  highlightRounds: 0,
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

/**
 * Physical copies of one passage the highlight round is willing to receive.
 *
 * A passage clause names a passage, not a row: `chunk_id` is deterministic
 * (`<document_id>:<seq>`) rather than unique, and during a content refresh the
 * old and new copies coexist — ingestion appends, and the engine applies the
 * delete asynchronously. Asking for one hit per clause would let a document
 * mid-refresh consume another document's slot and cost that document its
 * snippet. The multiplier is the overlap allowance; a passage carrying more
 * copies than this degrades to no snippet, never to another document's.
 */
export const HIGHLIGHT_COPIES_PER_PASSAGE = 4;

/**
 * The clause that addresses exactly this hit again. `chunk_id` on a
 * passage-granular generation, `document_id` where the document is the
 * indexed unit; both are raw-tokenised, so a quoted value is an exact term
 * lookup rather than a text match. Read from the hit rather than from the
 * generation's configuration, so a layout the index actually serves decides
 * it.
 */
const passageClause = (hit: CorpusIndexHit): string | null => {
  const chunkId = hit["chunk_id"];
  if (typeof chunkId === "string" && chunkId.length > 0) {
    return `chunk_id:${quoteCorpusValue(chunkId)}`;
  }
  const documentId = hit["document_id"];
  return typeof documentId === "string" && documentId.length > 0
    ? `document_id:${quoteCorpusValue(documentId)}`
    : null;
};

type ReadPageSnippetsOptions = {
  hitDispositions: CorpusHitDispositionCounter;
  observer: RegistryRequestObservation;
  clauses: readonly string[];
  cluster: QuickwitCluster;
  extractId: (hit: CorpusIndexHit) => string | null;
  extractSnippet: (
    snippet: Record<string, unknown> | undefined,
    hit: CorpusIndexHit,
  ) => string | null;
  indexId: string;
  query: string;
  snippetFields: string[];
};

type PageSnippets = {
  indexMs: number;
  rounds: number;
  snippetById: Map<string, string>;
};

/**
 * Highlight the passages the page emits, and only those.
 *
 * The scan's query is kept whole and narrowed by the page's passage clauses,
 * so the engine highlights against exactly the terms it matched on: the
 * snippet a hit gets here is the snippet the scan would have produced for it.
 * Hits arrive best-first, so the first hit seen for a document supplies its
 * snippet, matching how the scan chose the document's passage.
 */
const readPageSnippets = async ({
  hitDispositions,
  observer,
  clauses,
  cluster,
  extractId,
  extractSnippet,
  indexId,
  query,
  snippetFields,
}: ReadPageSnippetsOptions): Promise<PageSnippets> => {
  const snippetById = new Map<string, string>();
  if (clauses.length === 0 || snippetFields.length === 0) {
    return { indexMs: 0, rounds: 0, snippetById };
  }

  const startedAt = performance.now();
  const result = await getCorpusIndexClient(cluster).search({
    observer,
    indexId,
    query: `(${query}) AND (${clauses.join(" OR ")})`,
    maxHits: clauses.length * HIGHLIGHT_COPIES_PER_PASSAGE,
    sortBy: "_score",
    snippetFields,
  });
  const indexMs = performance.now() - startedAt;
  if (result.isErr()) {
    throw corpusIndexSearchFailure(result.error);
  }

  // Best-first, so the first snippet a document gets is its best-scoring
  // copy's; the later ones are the refresh overlap and are dropped.
  let malformed = 0;
  for (const [index, hit] of result.value.hits.entries()) {
    const disposition = classifyCorpusHit(hit, extractId);
    switch (disposition.type) {
      case "malformed":
        malformed += 1;
        break;
      case "valid": {
        const { id } = disposition;
        if (snippetById.has(id)) {
          break;
        }
        const snippet = extractSnippet(result.value.snippets[index], hit);
        if (snippet !== null) {
          snippetById.set(id, snippet);
        }
        break;
      }
      default:
        disposition satisfies never;
        panic("Unhandled corpus hit disposition");
    }
  }
  hitDispositions.record({ malformed });
  return { indexMs, rounds: 1, snippetById };
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
 * Position score of the hit at `globalIndex` in whichever order the engine was
 * asked for. Under `_score` it stands in for the lexical score, which the
 * engine reports the order of but not the values of; under a date sort it
 * stands in for the date the same way, and the blend is off, so the only
 * property either use needs is that it strictly decreases with rank. It
 * decays by a factor of e per round of candidates:
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
  Math.exp(-globalIndex / LIMITS.corpusIndexLexicalRankDecay);

type ScanRound = {
  numHits: number;
  hits: readonly CorpusIndexHit[];
  /** BM25 per hit, index-aligned with `hits`; null on the native transport. */
  scores: readonly number[] | null;
};

type ReadScanRoundOptions = {
  observer: RegistryRequestObservation;
  cluster: QuickwitCluster;
  indexId: string;
  query: string;
  order: CorpusSearchOrder;
  transport: CorpusIndexScanTransport;
  startOffset: number;
  maxHits: number;
};

/**
 * One scan round through the chosen transport. Both name the order
 * explicitly: without it the engine returns hits in document-id order and the
 * rank-based position score would be meaningless.
 */
const readScanRound = async ({
  observer,
  cluster,
  indexId,
  query,
  order,
  transport,
  startOffset,
  maxHits,
}: ReadScanRoundOptions): Promise<ScanRound> => {
  switch (transport.type) {
    case "native": {
      const result = await getCorpusIndexClient(cluster).search({
        observer,
        indexId,
        query,
        maxHits,
        startOffset,
        sortBy: corpusEngineSortBy(order),
      });
      if (result.isErr()) {
        throw corpusIndexSearchFailure(result.error);
      }
      return {
        numHits: result.value.numHits,
        hits: result.value.hits,
        scores: null,
      };
    }
    case "scored": {
      if (order.type !== "relevance") {
        panic("A scored scan reads relevance order only");
      }
      const result = await readScoredScanRound({
        observer,
        cluster,
        indexId,
        query,
        fields: transport.fields,
        from: startOffset,
        size: maxHits,
      });
      return {
        numHits: result.numHits,
        hits: result.hits.map((hit) => hit.fields),
        scores: result.hits.map((hit) => hit.score),
      };
    }
    default:
      transport satisfies never;
      return panic(`Unhandled scan transport: ${String(transport)}`);
  }
};

/**
 * What the scored transport reports, collected in the order the scan reads
 * it. A native round carries no scores and records nothing.
 */
const scanScoreRecorder = () => {
  const bestScoreById = new Map<string, number>();
  let topScore: number | null = null;
  let lastScore: number | null = null;
  return {
    recordRound: (round: ScanRound, startOffset: number): void => {
      if (round.scores === null) {
        return;
      }
      if (startOffset === 0) {
        topScore = round.scores.at(0) ?? null;
      }
      lastScore = round.scores.at(-1) ?? lastScore;
    },
    /** The hit at `index` is the first, so best, passage of document `id`. */
    recordBestPassage: (round: ScanRound, index: number, id: string): void => {
      const bm25 = round.scores?.[index];
      if (bm25 !== undefined) {
        bestScoreById.set(id, bm25);
      }
    },
    report: (
      scan: Pick<
        CorpusIndexScanScores,
        "passageClauseById" | "nextOffset" | "totalHits"
      >,
    ): CorpusIndexScanScores => ({
      ...scan,
      topScore,
      bestScoreById,
      lastScore,
    }),
  };
};

type ReadScoredScanRoundOptions = {
  observer: RegistryRequestObservation;
  cluster: QuickwitCluster;
  indexId: string;
  query: string;
  /** Fields the caller reads its id from; the passage fields are added. */
  fields: readonly string[];
  from: number;
  size: number;
};

/**
 * One `_score`-ordered round of ids and scores, projected to the caller's id
 * fields plus the passage fields the scan reads.
 */
const readScoredScanRound = async ({
  observer,
  cluster,
  indexId,
  query,
  fields,
  from,
  size,
}: ReadScoredScanRoundOptions): Promise<CorpusIndexScoredSearchResponse> => {
  const result = await getCorpusIndexClient(cluster).scoredSearch({
    observer,
    indexId,
    query,
    from,
    size,
    fields: [...new Set([...fields, ...CORPUS_INDEX_SCAN_PASSAGE_FIELDS])],
    // The caller's id is what the scan reads a hit by; the passage fields are
    // absent on a document-granular index and stay optional.
    requiredFields: fields,
  });
  if (result.isErr()) {
    throw corpusIndexSearchFailure(result.error);
  }
  return result.value;
};

const windowAfterCursor = (
  ranked: readonly RankedHit[],
  parsedCursor: SearchCursor | null,
): RankedHit[] =>
  parsedCursor === null
    ? [...ranked]
    : ranked.filter((hit) => isAfterSearchCursor(hit, parsedCursor));

/** `cursor`, carrying `groups` when there are any. */
const withGroups = (
  cursor: SearchCursor,
  groups: readonly string[] | undefined,
): SearchCursor =>
  groups === undefined || groups.length === 0
    ? cursor
    : { ...cursor, excludedGroups: groups };

/**
 * The groups a continuation into the next window must leave out: the ones
 * carried into this window and every one this window held. Everything the
 * window held was emitted (it moves only once its whole ranking fit on a
 * page). Null when the set outgrows the bound: such a continuation is not
 * offered, because a cursor that forgot a group would show it twice.
 */
const groupsPastWindow = (
  carried: ReadonlySet<string>,
  ranking: Pick<CorpusIndexRanking<unknown>, "groups">,
): string[] | null => {
  const groups = new Set([...carried, ...new Set(ranking.groups)]);
  return groups.size > LIMITS.corpusIndexSearchMaxExcludedGroups
    ? null
    : [...groups];
};

type ResolveCorpusSearchCursorOptions = {
  parsedCursor: SearchCursor | null;
  sort: SearchSort;
  pageRanked: readonly RankedHit[];
  hasMoreInWindow: boolean;
  windowCanContinue: boolean;
  roundCapHit: boolean;
  startOffset: number;
  totalHits: number;
  lastScannedId: string | null;
  ranking: Pick<CorpusIndexRanking<unknown>, "groups">;
  unseenScoreUpperBound: (nextLexicalScore: number) => number;
};

// The window itself moves only when the round cap ended the scan. The cap
// is what makes a page bounded-latency, and it is also why such a page
// cannot prove the blend bound the early stop proves: an unemitted hit in
// the next window may out-blend one this page emitted. Progress is worth
// more than that proof — a decision whose passages fill the whole capped
// window would otherwise leave the reader on a one-hit page with nowhere to
// go, and there is no ceiling on passages per document that the cap could
// be sized above (the chunker's is a hostile-input bound, orders of
// magnitude higher).
type ResolvedCorpusSearchCursor = Pick<
  CorpusIndexSearchPageResult<unknown>,
  "nextCursor" | "paginationOutcome"
>;

const resolveCorpusSearchCursor = ({
  parsedCursor,
  sort,
  pageRanked,
  hasMoreInWindow,
  windowCanContinue,
  roundCapHit,
  startOffset,
  totalHits,
  lastScannedId,
  ranking,
  unseenScoreUpperBound,
}: ResolveCorpusSearchCursorOptions): ResolvedCorpusSearchCursor => {
  const complete = (nextCursor: SearchCursor | null) => ({
    nextCursor,
    paginationOutcome: SEARCH_PAGINATION_COMPLETE,
  });
  const lastEmitted = pageRanked.at(-1);
  const carriedGroups = new Set(parsedCursor?.excludedGroups);
  const windowStart = parsedCursor?.windowStart ?? 0;
  if (hasMoreInWindow || (!roundCapHit && windowCanContinue)) {
    if (lastEmitted === undefined) {
      return complete(null);
    }
    // Still inside this window: the groups earlier windows showed stay
    // excluded, and this window's own are behind the cursor.
    return complete(
      withGroups(
        {
          score: lastEmitted.score,
          id: lastEmitted.id,
          sort,
          windowStart,
        },
        [...carriedGroups],
      ),
    );
  }
  if (!roundCapHit || startOffset >= totalHits) {
    return complete(null);
  }
  // Hydration can reject every candidate in a capped window. Its scanned
  // boundary still advances the next request, without an emitted hit.
  const boundaryId = lastScannedId ?? lastEmitted?.id;
  if (boundaryId === undefined) {
    return complete(null);
  }
  const excludedGroups = groupsPastWindow(carriedGroups, ranking);
  if (excludedGroups === null) {
    return {
      nextCursor: null,
      paginationOutcome: SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET,
    };
  }
  const unseenScoreBound = unseenScoreUpperBound(
    corpusIndexLexicalScore(startOffset),
  );
  return complete(
    withGroups(
      {
        // Above every blended score the next window can hold, by the bound's
        // own contract. Strictly above: equality would subject the first
        // unread hit to the cursor's id tie-break and could discard it.
        score:
          unseenScoreBound +
          Math.max(1, Math.abs(unseenScoreBound)) * Number.EPSILON,
        // This id is a scan boundary, not an emitted hit. Group tokens
        // exclude recurring results from earlier windows.
        id: boundaryId,
        sort,
        windowStart: startOffset,
      },
      excludedGroups,
    ),
  );
};

/**
 * One page of the cursor chain: a scan of the window its cursor names (the
 * first window without one) under the fixed round cap.
 */
const readWindowPage = async <TContext>({
  hitDispositions,
  observer,
  cluster,
  indexId,
  query,
  limit,
  order,
  parsedCursor,
  scanTransport = NATIVE_SCAN_TRANSPORT,
  maxRounds = LIMITS.corpusIndexSearchMaxRounds,
  snippetFields,
  extractId,
  extractSnippet,
  rankCandidates,
  unseenScoreUpperBound,
}: ObservedCorpusIndexSearchPageInput<TContext>): Promise<
  ScanPage<TContext>
> => {
  const rankingScope = rankingScopeOf(parsedCursor);
  const candidates: ScoredCandidate[] = [];
  const scores = scanScoreRecorder();
  /** Best passage per document, as the clause a snippet round addresses it by. */
  const passageClauseById = new Map<string, string>();
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
  let malformed = 0;
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
    if (rounds >= maxRounds) {
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

    // The round reads four things off a hit (its document, its passage clause,
    // its anchor, its rank). The native endpoint sends the whole stored
    // document, passage text included, and has no per-hit field projection;
    // the scored transport sends only those fields. Either way the snippet is
    // cut in the separate highlight round below, which keeps highlighting off
    // these hits.
    const roundStartedAt = performance.now();
    const round = await readScanRound({
      observer,
      cluster,
      indexId,
      query,
      order,
      transport: scanTransport,
      startOffset,
      maxHits,
    });
    indexMs += performance.now() - roundStartedAt;

    const hits = round.hits;
    if (hits.length === 0) {
      totalHits = round.numHits;
      break;
    }

    totalHits = Math.max(round.numHits, startOffset + hits.length);
    scores.recordRound(round, startOffset);
    for (const [index, hit] of hits.entries()) {
      const disposition = classifyCorpusHit(hit, extractId);
      switch (disposition.type) {
        case "malformed":
          malformed += 1;
          break;
        case "valid": {
          const { id } = disposition;
          lastScannedId = id;
          // Keep emitted candidates while replaying the window: their best
          // member must still represent the group when the ranker folds it.
          // The cursor comparison runs only after that fold.

          // Hits arrive best-first, so the first hit seen for a document is its
          // best-scoring passage: it sets the document's rank, the passage a
          // snippet is later cut from, and the anchor the result deep-links to.
          // Later passages of the same document only add to its breadth count.
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
          scores.recordBestPassage(round, index, id);

          const clause = passageClause(hit);
          if (clause !== null) {
            passageClauseById.set(id, clause);
          }
          const anchorId = readAnchorId(hit);
          if (anchorId !== null) {
            anchorIdById.set(id, anchorId);
          }
          break;
        }
        default:
          disposition satisfies never;
          panic("Unhandled corpus hit disposition");
      }
    }

    hitDispositions.record({ malformed });
    malformed = 0;
    startOffset += hits.length;
    scanned += hits.length;
    ranking = await rankCandidates(candidates, rankingScope);
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
    ranking = await rankCandidates(candidates, rankingScope);
    windowed = windowAfterCursor(ranking.ranked, parsedCursor);
  }
  const hasMoreInWindow = windowed.length > limit;
  const pageRanked = hasMoreInWindow ? windowed.slice(0, limit) : windowed;
  // A follow-up request replays this window and can only reach deeper
  // candidates while the window's own budget is not exhausted; past it a
  // cursor could never be satisfied and must not be advertised.
  const windowCanContinue = startOffset < totalHits && scanned < scanBudget();
  const { nextCursor, paginationOutcome } = resolveCorpusSearchCursor({
    parsedCursor,
    sort: order.type,
    pageRanked,
    hasMoreInWindow,
    windowCanContinue,
    roundCapHit,
    startOffset,
    totalHits,
    lastScannedId,
    ranking,
    unseenScoreUpperBound,
  });

  const snippets = await readPageSnippets({
    hitDispositions,
    observer,
    clauses: pageRanked.flatMap((hit) => {
      const clause = passageClauseById.get(hit.id);
      return clause === undefined ? [] : [clause];
    }),
    cluster,
    extractId,
    extractSnippet,
    indexId,
    query,
    snippetFields,
  });

  return {
    pageRanked,
    context: ranking.context,
    snippetById: snippets.snippetById,
    anchorIdById,
    passageCountById,
    passageClauseById,
    nextCursor,
    paginationOutcome,
    scan: {
      rounds,
      passagesScanned: scanned,
      indexMs: indexMs + snippets.indexMs,
      earlyStopped,
      roundCapHit,
      highlightRounds: snippets.rounds,
    },
    lexicalScores:
      scanTransport.type === "scored"
        ? scores.report({
            passageClauseById,
            nextOffset: startOffset,
            totalHits,
          })
        : null,
  };
};

/**
 * Windows a page addressed by offset may walk. A window is what one cursor
 * page scans under the fixed round cap; the chain moves to the next window
 * once it has shown everything the previous one ranked. Sized so the depth
 * bound is reachable when a decision costs up to `PASSAGE_OVER_FETCH`
 * passages; a page past what these windows hold is reported as stopped on
 * its budget, never as the end of the results.
 */
const OFFSET_PAGE_WINDOW_CAP = Math.ceil(
  (LIMITS.caseLawResultDepthMax * PASSAGE_OVER_FETCH) /
    (LIMITS.corpusIndexSearchMaxRounds *
      LIMITS.corpusIndexSearchCandidateLimit),
);

/** Engine round trips one page addressed by offset may spend scanning. */
export const CORPUS_INDEX_OFFSET_PAGE_MAX_ROUNDS =
  OFFSET_PAGE_WINDOW_CAP * LIMITS.corpusIndexSearchMaxRounds;

/**
 * A page addressed by offset: the cursor chain's own pages, replayed in one
 * request, and the slice of them the offset names.
 *
 * Exact by construction rather than by a property of the ranking. Each step
 * is the very page a client following cursors would read (the same window,
 * the same fixed round cap, the same cursor), asked for as many results as
 * are still missing; the chain's results do not depend on how it is cut
 * into pages, because a page that stops early has proven its order and one
 * that hits the cap shows its whole window before the window moves. So the
 * results here are the chain's results, in its order, and the cursor handed
 * on is the one the chain holds after the page's last result.
 */
const readOffsetChainPage = async <TContext>(
  options: ObservedCorpusIndexSearchPageInput<TContext>,
): Promise<ScanPage<TContext>> => {
  const { limit, parsedCursor, skip = 0 } = options;
  if (parsedCursor !== null) {
    panic("A search page is placed by its cursor or by its offset, not both");
  }
  const reach = skip + limit;
  const chain: RankedHit[] = [];
  const anchorIdById = new Map<string, string>();
  const passageCountById = new Map<string, number>();
  const passageClauseById = new Map<string, string>();
  const scan = emptyCorpusIndexScan();
  let step: ScanPage<TContext> | null = null;
  let cursor: SearchCursor | null = null;
  for (
    let window = 0;
    window < OFFSET_PAGE_WINDOW_CAP &&
    chain.length < reach &&
    (step === null || cursor !== null);
    window += 1
  ) {
    // Sequential by construction: each step continues from the cursor the
    // step before it ended on, exactly as the chain does.
    step = await readWindowPage({
      ...options,
      limit: reach - chain.length,
      parsedCursor: cursor,
      // Only the page's own results are highlighted, once, below.
      snippetFields: [],
    });
    chain.push(...step.pageRanked);
    for (const [id, anchor] of step.anchorIdById) {
      anchorIdById.set(id, anchor);
    }
    for (const [id, count] of step.passageCountById) {
      passageCountById.set(id, count);
    }
    for (const [id, clause] of step.passageClauseById) {
      passageClauseById.set(id, clause);
    }
    scan.rounds += step.scan.rounds;
    scan.passagesScanned += step.scan.passagesScanned;
    scan.indexMs += step.scan.indexMs;
    scan.earlyStopped = step.scan.earlyStopped;
    cursor = step.nextCursor;
  }
  if (step === null) {
    return panic("An offset page reads at least one window");
  }
  const pageRanked = chain.slice(skip, reach);
  const snippets = await readPageSnippets({
    hitDispositions: options.hitDispositions,
    observer: options.observer,
    clauses: pageRanked.flatMap((hit) => {
      const clause = passageClauseById.get(hit.id);
      return clause === undefined ? [] : [clause];
    }),
    cluster: options.cluster,
    extractId: options.extractId,
    extractSnippet: options.extractSnippet,
    indexId: options.indexId,
    query: options.query,
    snippetFields: options.snippetFields,
  });
  return {
    pageRanked,
    context: step.context,
    snippetById: snippets.snippetById,
    anchorIdById,
    passageCountById,
    passageClauseById,
    nextCursor: cursor,
    paginationOutcome: step.paginationOutcome,
    scan: {
      ...scan,
      indexMs: scan.indexMs + snippets.indexMs,
      // The windows ran out with the chain still going: the page was not
      // reached, which is not the same as the results ending before it.
      roundCapHit: chain.length < reach && cursor !== null,
      highlightRounds: snippets.rounds,
    },
    lexicalScores: null,
  };
};

/** A page of the position scan: by cursor, or by offset along the chain. */
const readPositionSearchPage = async <TContext>(
  options: ObservedCorpusIndexSearchPageInput<TContext>,
): Promise<ScanPage<TContext>> =>
  (options.skip ?? 0) > 0
    ? await readOffsetChainPage(options)
    : await readWindowPage(options);

type ScoredPassage = CorpusIndexScoredSearchResponse["hits"][number];

const compareBm25Passages = (
  left: ScoredPassage,
  right: ScoredPassage,
): number => {
  const scoreOrder = right.score - left.score;
  if (scoreOrder !== 0) {
    return scoreOrder;
  }
  for (const field of ["document_id", "anchor_id", "chunk_id"] as const) {
    const leftValue = left.fields[field];
    const rightValue = right.fields[field];
    const leftId = typeof leftValue === "string" ? leftValue : "";
    const rightId = typeof rightValue === "string" ? rightValue : "";
    if (leftId < rightId) {
      return -1;
    }
    if (leftId > rightId) {
      return 1;
    }
  }
  return 0;
};

const bm25TopScore = (hits: readonly ScoredPassage[]): number | null => {
  const topScore = hits.at(0)?.score ?? null;
  if (topScore !== null && topScore < 0) {
    panic("BM25 ratio ranking requires a nonnegative top score");
  }
  for (const { score } of hits) {
    if (topScore === null || score < 0 || score > topScore) {
      panic("BM25 ratio ranking received an invalid score");
    }
  }
  return topScore;
};

/** A bounded candidate universe, replayed whole before grouping and paging. */
const readBm25SearchPage = async <TContext>(
  options: ObservedCorpusIndexSearchPageInput<TContext>,
): Promise<ScanPage<TContext>> => {
  const {
    hitDispositions,
    observer,
    cluster,
    indexId,
    query,
    limit,
    order,
    parsedCursor,
    skip = 0,
    scanTransport,
    snippetFields,
    extractId,
    extractSnippet,
    rankCandidates,
  } = options;
  if (
    order.type !== "relevance" ||
    scanTransport?.type !== "scored" ||
    (parsedCursor !== null && parsedCursor.windowStart !== 0)
  ) {
    panic("BM25 ranking requires a scored relevance scan in window zero");
  }
  const startedAt = performance.now();
  const round = await readScoredScanRound({
    observer,
    cluster,
    indexId,
    query,
    fields: scanTransport.fields,
    from: 0,
    size: CORPUS_BM25_PASSAGE_LIMIT + 1,
  });
  const indexMs = performance.now() - startedAt;
  const topScore = bm25TopScore(round.hits);
  const cutoff = round.hits.at(CORPUS_BM25_PASSAGE_LIMIT - 1);
  const lookahead = round.hits.at(CORPUS_BM25_PASSAGE_LIMIT);
  if (
    cutoff !== undefined &&
    lookahead !== undefined &&
    cutoff.score === lookahead.score
  ) {
    // The pinned engine cannot sort text identities. A tied cutoff cannot
    // define a stable universe, so this query stays on the position path.
    if (parsedCursor !== null) {
      throw new HandlerError({ status: 400, message: "Invalid cursor" });
    }
    const page = await readPositionSearchPage({
      ...options,
      scanTransport: options.fallbackScanTransport ?? scanTransport,
    });
    if (page.nextCursor !== null) {
      page.nextCursor = { ...page.nextCursor, rankingMode: "off" };
    }
    page.scan.indexMs += indexMs;
    page.scan.rounds += 1;
    page.scan.passagesScanned += round.hits.length;
    return page;
  }
  const hits = round.hits
    .slice(0, CORPUS_BM25_PASSAGE_LIMIT)
    .toSorted(compareBm25Passages);
  const candidates: ScoredCandidate[] = [];
  const bestScoreById = new Map<string, number>();
  const passageClauseById = new Map<string, string>();
  const anchorIdById = new Map<string, string>();
  const passageCountById = new Map<string, number>();
  let malformed = 0;
  for (const { fields: hit, score } of hits) {
    if (topScore === null) {
      panic("A nonempty BM25 universe requires a top score");
    }
    const disposition = classifyCorpusHit(hit, extractId);
    switch (disposition.type) {
      case "malformed":
        malformed += 1;
        break;
      case "valid": {
        const { id } = disposition;
        const seen = passageCountById.get(id);
        passageCountById.set(id, (seen ?? 0) + 1);
        if (seen !== undefined) {
          continue;
        }
        // Retain the cursor decision until grouping; dropping its representative
        // could expose a language sibling and repeat a judgment on the next page.
        // Filter-only matches can have no lexical signal (all scores zero).
        candidates.push({
          id,
          score:
            topScore === 0 ? 0 : (score / topScore) ** CORPUS_BM25_RATIO_POWER,
        });
        bestScoreById.set(id, score);
        const clause = passageClause(hit);
        if (clause !== null) {
          passageClauseById.set(id, clause);
        }
        const anchor = readAnchorId(hit);
        if (anchor !== null) {
          anchorIdById.set(id, anchor);
        }
        break;
      }
      default:
        disposition satisfies never;
        panic("Unhandled corpus hit disposition");
    }
  }
  hitDispositions.record({ malformed });
  const ranking = await rankCandidates(
    candidates,
    rankingScopeOf(parsedCursor),
  );
  const windowed = windowAfterCursor(ranking.ranked, parsedCursor);
  const pageRanked = windowed.slice(skip, skip + limit);
  const last = pageRanked.at(-1);
  // The universe replays whole from window zero, so the cursor's position
  // alone keeps this page's groups behind it; exclusions it carried in stay.
  const nextCursor =
    windowed.length > skip + limit && last !== undefined
      ? withGroups(
          {
            score: last.score,
            id: last.id,
            sort: order.type,
            windowStart: 0,
            rankingMode: "bm25-ratio",
          },
          parsedCursor?.excludedGroups,
        )
      : null;
  const snippets = await readPageSnippets({
    hitDispositions,
    observer,
    clauses: pageRanked.flatMap((hit) => {
      const clause = passageClauseById.get(hit.id);
      return clause === undefined ? [] : [clause];
    }),
    cluster,
    extractId,
    extractSnippet,
    indexId,
    query,
    snippetFields,
  });
  return {
    pageRanked,
    context: ranking.context,
    snippetById: snippets.snippetById,
    anchorIdById,
    passageCountById,
    passageClauseById,
    nextCursor,
    paginationOutcome: SEARCH_PAGINATION_COMPLETE,
    scan: {
      rounds: 1,
      passagesScanned: hits.length,
      indexMs: indexMs + snippets.indexMs,
      earlyStopped: false,
      roundCapHit: false,
      highlightRounds: snippets.rounds,
    },
    lexicalScores: {
      topScore,
      bestScoreById,
      passageClauseById,
      nextOffset: hits.length,
      totalHits: round.numHits,
      lastScore: hits.at(-1)?.score ?? null,
    },
  };
};

const readScanPage = async <TContext>(
  options: ObservedCorpusIndexSearchPageInput<TContext>,
): Promise<ScanPage<TContext>> => {
  const cursorMode = options.parsedCursor?.rankingMode;
  if (
    cursorMode === "bm25-ratio" &&
    (options.rankingMode !== "bm25-ratio" ||
      options.parsedCursor?.windowStart !== 0)
  ) {
    throw new HandlerError({ status: 400, message: "Invalid cursor" });
  }
  const mode =
    options.parsedCursor === null
      ? (options.rankingMode ?? "off")
      : (options.parsedCursor.rankingMode ?? "off");
  switch (mode) {
    case "bm25-ratio":
      return await readBm25SearchPage(options);
    case "off": {
      const page = await readPositionSearchPage({
        ...options,
        scanTransport: options.fallbackScanTransport ?? options.scanTransport,
      });
      if (
        page.nextCursor !== null &&
        (options.rankingMode === "bm25-ratio" ||
          options.parsedCursor?.rankingMode === "off")
      ) {
        page.nextCursor = { ...page.nextCursor, rankingMode: "off" };
      }
      return page;
    }
    default:
      mode satisfies never;
      return panic("Unknown corpus ranking mode");
  }
};

/**
 * Judges whether the scan placed a page addressed by offset. Its window cap
 * assumes a decision costs at most `PASSAGE_OVER_FETCH` passages, and nothing
 * enforces that: when decisions matched more passages, the windows run out
 * before the chain reaches the page. Such a page is short or empty without
 * the results having ended, so it is reported as stopped on its budget and
 * offers no cursor, rather than reading as the end of the list.
 */
const withPageReach = <TContext>(
  page: ScanPage<TContext>,
  {
    limit,
    skip = 0,
  }: Pick<CorpusIndexSearchPageInput<TContext>, "limit" | "skip">,
): CorpusIndexSearchPageResult<TContext> =>
  skip > 0 && page.pageRanked.length < limit && page.scan.roundCapHit
    ? { ...page, nextCursor: null, reach: SEARCH_PAGE_REACH.SCAN_BUDGET }
    : { ...page, reach: SEARCH_PAGE_REACH.REACHED };

const readObservedCorpusIndexSearchPage = async <TContext>(
  options: ObservedCorpusIndexSearchPageInput<TContext>,
): Promise<CorpusIndexSearchPageResult<TContext>> =>
  withPageReach(await readScanPage(options), options);

export const readCorpusIndexSearchPage = async <TContext>(
  options: CorpusIndexSearchPageInput<TContext>,
): Promise<CorpusIndexSearchPageResult<TContext>> => {
  const hitDispositions =
    options.hitDispositions ?? createCorpusHitDispositionCounter();
  const page = await readObservedCorpusIndexSearchPage({
    ...options,
    hitDispositions,
  });
  if (options.hitDispositions === undefined) {
    reportCorpusHitDispositions({ counts: hitDispositions.snapshot() });
  }
  return page;
};
