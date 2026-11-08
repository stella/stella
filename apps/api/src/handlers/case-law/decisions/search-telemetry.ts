import { panic } from "better-result";

import type { DecisionQueryIntent } from "@stll/api-contract/decision-query-intent";
import { observeRegistryRequest } from "@stll/business-registries/shared/request-observer";
import type { RegistryRequestObservation } from "@stll/business-registries/shared/request-observer";

import type { CorpusAggregateCacheOutcome } from "@/api/lib/legal-search/corpus-aggregate-cache";
import type { CorpusHitDispositionCounts } from "@/api/lib/legal-search/corpus-hit-telemetry";
import { tokenizeCorpusFreeText } from "@/api/lib/legal-search/corpus-query";
import { publicReadTimeoutError } from "@/api/lib/legal-search/public-read-timeout";
import { remainingRequestBudgetMs } from "@/api/lib/load/request-latency-budget";
import type { LoggerAttributes } from "@/api/lib/observability/logger";
import { logger } from "@/api/lib/observability/logger";

/**
 * What a case-law search cost, per request. Latency here is dominated by how
 * many times the scan went back to the index, which nothing outside the
 * request could otherwise see: the response carries a page either way.
 *
 * The entry itself is never an attribute. Its shape is: a docket or an ECLI
 * is answered from identity columns, a quoted phrase and loose terms hit the
 * index differently, and that is as much as telemetry needs to explain a
 * slow request.
 *
 * Which of those an entry is comes from the same tokenizer that builds the
 * engine query, never from a second scan of the raw text: the quote
 * conventions a phrase may be written in are the tokenizer's to know, and a
 * quote that opens no span is not a phrase at all.
 */
export const DECISION_QUERY_CLASS = {
  empty: "empty",
  identifier: "identifier",
  phrase: "phrase",
  term: "term",
} as const;

export type DecisionQueryClass =
  (typeof DECISION_QUERY_CLASS)[keyof typeof DECISION_QUERY_CLASS];

export const decisionQueryClass = (
  intent: DecisionQueryIntent,
): DecisionQueryClass => {
  switch (intent.type) {
    case "empty":
      return DECISION_QUERY_CLASS.empty;
    case "identifier":
      return DECISION_QUERY_CLASS.identifier;
    case "text": {
      const tokens = tokenizeCorpusFreeText(intent.text);
      if (tokens.length === 0) {
        return DECISION_QUERY_CLASS.empty;
      }
      return tokens.some((token) => token.type === "phrase")
        ? DECISION_QUERY_CLASS.phrase
        : DECISION_QUERY_CLASS.term;
    }
    default: {
      intent satisfies never;
      return panic(`Unhandled decision query intent: ${String(intent)}`);
    }
  }
};

type CaseLawFunctionWordsExcludedEvent = {
  country: string;
  /** Tokens the reader typed. */
  queryTokens: number;
  /** Of those, the function words the search did not require. */
  excludedTokens: number;
  /** Hits the page carried under the words it did require. */
  hitsReturned: number;
};

/**
 * One record per search that stopped requiring a function word.
 *
 * Counts only, never the words: a query's terms are the reader's own
 * question, and a public-corpus search is answered for anonymous readers, so
 * the record says how much was dropped rather than what. The shape answers
 * the one question the change raises — whether dropping function words turns
 * empty pages into pages — from `excludedTokens > 0` against
 * `hitsReturned`, per jurisdiction.
 */
export const reportCaseLawFunctionWordsExcluded = ({
  country,
  queryTokens,
  excludedTokens,
  hitsReturned,
}: CaseLawFunctionWordsExcludedEvent): void => {
  if (excludedTokens === 0) {
    return;
  }
  logger.info("case_law.search.function_words_excluded", {
    country,
    queryTokens,
    excludedTokens,
    hitsReturned,
  });
};

/**
 * The Postgres reads one corpus-index search makes, named so a record can say
 * which one a slow request waited on rather than only how long it waited in
 * total.
 */
export const CASE_LAW_SEARCH_DB_READ = {
  /** Language versions of the decisions on the page. */
  alternates: "alternates",
  /** The scan's candidates, rehydrated and refiltered. */
  candidates: "candidates",
  /** The court rank registry the blend's tier signal reads. */
  courtWeights: "courtWeights",
  /** The decisions an entry names outright. */
  identity: "identity",
  /** The display rows of the decisions the page emits. */
  page: "page",
  /** Which corpus-index generation currently serves. */
  servingGeneration: "servingGeneration",
  /** The source policy and bucket labels the facet read counts under. */
  sourceRegistry: "sourceRegistry",
} as const;

type CaseLawSearchDbRead =
  (typeof CASE_LAW_SEARCH_DB_READ)[keyof typeof CASE_LAW_SEARCH_DB_READ];

/**
 * The record's attribute per read. Total over the reads, and derived from
 * them, so a read added without an attribute is a compile error rather than a
 * number quietly missing from the log.
 */
const DB_READ_ATTRIBUTE = {
  alternates: "dbAlternatesMs",
  candidates: "dbCandidatesMs",
  courtWeights: "dbCourtWeightsMs",
  identity: "dbIdentityMs",
  page: "dbPageMs",
  servingGeneration: "dbServingGenerationMs",
  sourceRegistry: "dbSourceRegistryMs",
} as const satisfies Record<CaseLawSearchDbRead, string>;

type CaseLawSearchDbTiming = {
  /** How many reads the request made, over all the named kinds. */
  reads: number;
  msByRead: Record<CaseLawSearchDbRead, number>;
};

export type CaseLawSearchDbTimer = {
  /**
   * Brackets one read. The work is a thunk, so the clock starts before the
   * query does; a helper that owns its own `caseLawDb` call takes this as its
   * hook instead of being timed from outside, because ranking, folding and
   * collapsing are not database time.
   */
  time: <TRead>(
    read: CaseLawSearchDbRead,
    run: () => Promise<TRead>,
  ) => Promise<TRead>;
  /**
   * Records a read timed at its call site. For the reads a lint rule requires
   * the handler to invoke directly, which a thunk would hide.
   */
  record: (read: CaseLawSearchDbRead, ms: number) => void;
  timing: () => CaseLawSearchDbTiming;
  /** Reads `time` began that never settled, which `timing` cannot count. */
  unfinished: () => { read: CaseLawSearchDbRead; ms: number }[];
};

const createCaseLawSearchDbTimer = (): CaseLawSearchDbTimer => {
  const msByRead: Record<CaseLawSearchDbRead, number> = {
    alternates: 0,
    candidates: 0,
    courtWeights: 0,
    identity: 0,
    page: 0,
    servingGeneration: 0,
    sourceRegistry: 0,
  };
  let reads = 0;
  const running = new Set<{ read: CaseLawSearchDbRead; startedAt: number }>();

  const record = (read: CaseLawSearchDbRead, ms: number): void => {
    msByRead[read] += ms;
    reads += 1;
  };

  return {
    record,
    time: async (read, run) => {
      const entry = { read, startedAt: performance.now() };
      running.add(entry);
      // Left in `running` when `run` rejects: a read the request gave up on
      // is exactly what a record of an unfinished request has to name.
      const rows = await run();
      running.delete(entry);
      record(read, performance.now() - entry.startedAt);
      return rows;
    },
    timing: () => ({ reads, msByRead: { ...msByRead } }),
    unfinished: () =>
      [...running].map(({ read, startedAt }) => ({
        read,
        ms: performance.now() - startedAt,
      })),
  };
};

/**
 * Flat, one attribute per read, and the total is what those attributes add
 * up to: a breakdown that does not reconcile with its total is worse than
 * no breakdown.
 */
const dbAttributes = (db: CaseLawSearchDbTiming): LoggerAttributes => {
  const msByAttribute: LoggerAttributes = {};
  let dbMs = 0;
  for (const read of Object.values(CASE_LAW_SEARCH_DB_READ)) {
    const ms = Math.round(db.msByRead[read]);
    msByAttribute[DB_READ_ATTRIBUTE[read]] = ms;
    dbMs += ms;
  }
  return { dbReads: db.reads, dbMs, ...msByAttribute };
};

/**
 * Where a search has got to. The completed record is written once at the end
 * of a search that has an answer, so a search that runs out of time writes
 * nothing and the slowest requests are absent from the data. This is what is
 * known about one at any moment, written if it never completes.
 */
type CaseLawSearchPhase =
  | "serving_target"
  | "identity"
  | "query_resolve"
  | "scan_and_facets"
  | "page_rows"
  | "alternates"
  | "partial_top_up";

export type CaseLawSearchTrace = {
  readonly startedAt: number;
  readonly dbTimer: CaseLawSearchDbTimer;
  readonly country: string | undefined;
  phase: CaseLawSearchPhase;
  queryClass: DecisionQueryClass | null;
  /** Calls the corpus index was sent, counted when each one is issued. */
  engineRequests: number;
  /** Zero until the facet read settles. */
  facetMs: number;
  scanSettled: boolean;
  /** Set once the completed record is written; nothing further is owed. */
  reported: boolean;
};

const reportCaseLawSearchIncomplete = (
  trace: CaseLawSearchTrace,
  outcome: "failed" | "timed_out",
): void => {
  const unfinished = trace.dbTimer.unfinished();
  const remainingBudgetMs = remainingRequestBudgetMs();
  logger.warn("case_law.search.incomplete", {
    outcome,
    phase: trace.phase,
    ...(trace.queryClass === null ? {} : { queryClass: trace.queryClass }),
    ...(trace.country === undefined ? {} : { country: trace.country }),
    ...dbAttributes(trace.dbTimer.timing()),
    dbUnfinishedReads: unfinished.map(({ read }) => read).join(","),
    dbUnfinishedMs: Math.round(Math.max(0, ...unfinished.map(({ ms }) => ms))),
    engineRequests: trace.engineRequests,
    scanSettled: trace.scanSettled,
    facetMs: Math.round(trace.facetMs),
    totalMs: Math.round(performance.now() - trace.startedAt),
    ...(remainingBudgetMs === undefined
      ? {}
      : { remainingBudgetMs: Math.round(remainingBudgetMs) }),
  });
};

type RunTracedCaseLawSearchOptions<TAnswer> = {
  country: string | undefined;
  observer: RegistryRequestObservation;
  run: (
    trace: CaseLawSearchTrace,
    observer: RegistryRequestObservation,
  ) => Promise<TAnswer>;
};

export const createCaseLawSearchTrace = (
  country: string | undefined,
): CaseLawSearchTrace => ({
  startedAt: performance.now(),
  dbTimer: createCaseLawSearchDbTimer(),
  country,
  phase: "serving_target",
  queryClass: null,
  engineRequests: 0,
  facetMs: 0,
  scanSettled: false,
  reported: false,
});

/**
 * Runs a search and writes `case_law.search.incomplete` for one that rejects
 * or answers with its time budget spent. A refusal at the boundary is an
 * answer, and searched nothing to report.
 */
export const runTracedCaseLawSearch = async <TAnswer>({
  country,
  observer,
  run,
}: RunTracedCaseLawSearchOptions<TAnswer>): Promise<TAnswer> => {
  const trace = createCaseLawSearchTrace(country);
  const counted = {
    onRequest: () => {
      trace.engineRequests += 1;
      observeRegistryRequest(observer);
    },
    // Unused: `onRequest` above cannot throw, `observeRegistryRequest` having
    // contained whatever the observer it forwards to does.
    onError: () => undefined,
  };
  let settled = false;
  try {
    const answer = await run(trace, counted);
    settled = true;
    if (publicReadTimeoutError(answer) !== null && !trace.reported) {
      reportCaseLawSearchIncomplete(trace, "timed_out");
    }
    return answer;
  } finally {
    if (!settled && !trace.reported) {
      reportCaseLawSearchIncomplete(trace, "failed");
    }
  }
};

type CaseLawSearchCompletedEvent = {
  hitDispositions: CorpusHitDispositionCounts;
  /** Candidate rows read for blending, including ones the filters dropped. */
  candidatesHydrated: number;
  country: string | undefined;
  /** This request's Postgres reads, per read. The total is their sum. */
  db: CaseLawSearchDbTiming;
  /** The scan stopped because no unseen candidate could out-blend the page. */
  earlyStopped: boolean;
  /**
   * Where the facet read's aggregations came from, counted per named
   * aggregation rather than per engine call. All zero when the request read
   * no facets.
   */
  facetCache: CorpusAggregateCacheOutcome;
  /**
   * Wall time of the facet read that runs beside the page read: its engine
   * aggregation plus the source-registry read it fails closed on, which
   * `dbSourceRegistryMs` reports as well. Zero when the request asked for no
   * facets, which a cursor page does.
   */
  facetMs: number;
  hitsReturned: number;
  /**
   * Summed wall time of the engine calls the page read made: the scan's
   * rounds and the page's highlight round, which run in sequence. The facet
   * read runs beside all of them, so `indexMs` and `facetMs` overlap and must
   * never be added; `scanAndFacetsMs` is what the request waited on the two.
   */
  indexMs: number;
  /** Wide rows read for the page, after ranking decided which ids it holds. */
  pageRowsRead: number;
  passagesScanned: number;
  queryClass: DecisionQueryClass;
  /** The scan stopped at the round cap rather than at its own bound. */
  roundCapHit: boolean;
  /** Engine round trips the scan spent. */
  rounds: number;
  /** Engine round trips spent highlighting the page: one, or none for an empty page. */
  highlightRounds: number;
  /**
   * Wall time of the phase where the page read and the facet read run
   * together: the critical path through the two, never their sum. It brackets
   * the phase rather than the engine, so it also covers the candidate
   * rehydration the scan interleaves between its rounds. Zero for a request
   * that never entered the phase: one answered by identity, or one whose
   * entry left nothing to query.
   */
  scanAndFacetsMs: number;
  totalMs: number;
};

/**
 * One record per search that reached the corpus index or the identity path.
 * A request rejected at the boundary (a malformed cursor, an unknown
 * country) searched nothing and reports nothing.
 */
export const reportCaseLawSearchCompleted = ({
  hitDispositions,
  candidatesHydrated,
  country,
  db,
  earlyStopped,
  facetCache,
  facetMs,
  hitsReturned,
  indexMs,
  pageRowsRead,
  passagesScanned,
  queryClass,
  roundCapHit,
  rounds,
  highlightRounds,
  scanAndFacetsMs,
  totalMs,
}: CaseLawSearchCompletedEvent): void => {
  logger.info("case_law.search.completed", {
    ...hitDispositions,
    queryClass,
    ...(country === undefined ? {} : { country }),
    rounds,
    highlightRounds,
    passagesScanned,
    candidatesHydrated,
    pageRowsRead,
    hitsReturned,
    indexMs: Math.round(indexMs),
    facetMs: Math.round(facetMs),
    facetCacheHits: facetCache.hits,
    facetCacheMisses: facetCache.misses,
    facetCacheSharedFlights: facetCache.sharedFlights,
    scanAndFacetsMs: Math.round(scanAndFacetsMs),
    ...dbAttributes(db),
    totalMs: Math.round(totalMs),
    roundCapHit,
    earlyStopped,
  });
};
