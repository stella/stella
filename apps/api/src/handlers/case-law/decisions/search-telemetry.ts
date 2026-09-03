import { panic } from "better-result";

import type { DecisionQueryIntent } from "@stll/api-contract/decision-query-intent";

import { tokenizeCorpusFreeText } from "@/api/lib/legal-search/corpus-query";
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
      const exhaustive: never = intent;
      return panic(`Unhandled decision query intent: ${String(exhaustive)}`);
    }
  }
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
  /** The decisions an entry names outright. */
  identity: "identity",
  /** The display rows of the decisions the page emits. */
  page: "page",
  /** Which corpus-index generation currently serves. */
  servingGeneration: "servingGeneration",
} as const;

export type CaseLawSearchDbRead =
  (typeof CASE_LAW_SEARCH_DB_READ)[keyof typeof CASE_LAW_SEARCH_DB_READ];

/**
 * The record's attribute per read. Total over the reads, and derived from
 * them, so a read added without an attribute is a compile error rather than a
 * number quietly missing from the log.
 */
const DB_READ_ATTRIBUTE = {
  alternates: "dbAlternatesMs",
  candidates: "dbCandidatesMs",
  identity: "dbIdentityMs",
  page: "dbPageMs",
  servingGeneration: "dbServingGenerationMs",
} as const satisfies Record<CaseLawSearchDbRead, string>;

export type CaseLawSearchDbTiming = {
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
};

export const createCaseLawSearchDbTimer = (): CaseLawSearchDbTimer => {
  const msByRead: Record<CaseLawSearchDbRead, number> = {
    alternates: 0,
    candidates: 0,
    identity: 0,
    page: 0,
    servingGeneration: 0,
  };
  let reads = 0;

  const record = (read: CaseLawSearchDbRead, ms: number): void => {
    msByRead[read] += ms;
    reads += 1;
  };

  return {
    record,
    time: async (read, run) => {
      const startedAt = performance.now();
      const rows = await run();
      record(read, performance.now() - startedAt);
      return rows;
    },
    timing: () => ({ reads, msByRead: { ...msByRead } }),
  };
};

type CaseLawSearchCompletedEvent = {
  /** Candidate rows read for blending, including ones the filters dropped. */
  candidatesHydrated: number;
  country: string | undefined;
  /** This request's Postgres reads, per read. The total is their sum. */
  db: CaseLawSearchDbTiming;
  /** The scan stopped because no unseen candidate could out-blend the page. */
  earlyStopped: boolean;
  hitsReturned: number;
  /** Summed wall time of this request's engine calls. */
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
  totalMs: number;
};

/**
 * One record per search that reached the corpus index or the identity path.
 * A request rejected at the boundary (a malformed cursor, an unknown
 * country) searched nothing and reports nothing.
 */
export const reportCaseLawSearchCompleted = ({
  candidatesHydrated,
  country,
  db,
  earlyStopped,
  hitsReturned,
  indexMs,
  pageRowsRead,
  passagesScanned,
  queryClass,
  roundCapHit,
  rounds,
  highlightRounds,
  totalMs,
}: CaseLawSearchCompletedEvent): void => {
  // Flat, one attribute per read, and the total is what those attributes add
  // up to: a breakdown that does not reconcile with its total is worse than
  // no breakdown.
  const msByAttribute: LoggerAttributes = {};
  let dbMs = 0;
  for (const read of Object.values(CASE_LAW_SEARCH_DB_READ)) {
    const ms = Math.round(db.msByRead[read]);
    msByAttribute[DB_READ_ATTRIBUTE[read]] = ms;
    dbMs += ms;
  }

  logger.info("case_law.search.completed", {
    queryClass,
    ...(country === undefined ? {} : { country }),
    rounds,
    highlightRounds,
    passagesScanned,
    candidatesHydrated,
    pageRowsRead,
    hitsReturned,
    indexMs: Math.round(indexMs),
    dbReads: db.reads,
    dbMs,
    ...msByAttribute,
    totalMs: Math.round(totalMs),
    roundCapHit,
    earlyStopped,
  });
};
