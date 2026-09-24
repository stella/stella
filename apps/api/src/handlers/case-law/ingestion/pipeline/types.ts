import type { ScopedDb } from "@/api/db/safe-db";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import type {
  CaseLawCorpusDependencies,
  CaseLawJudgeDependencies,
} from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import type { RuleCache } from "@/api/handlers/case-law/polarity/rule-engine";
import type { SafeId } from "@/api/lib/branded-types";
import type { CorpusPackBatch } from "@/api/lib/legal-search/corpus-pack-batch";

export const CONTENTION_RECONCILIATION = {
  INITIAL: "initial",
  RETRY: "retry",
} as const;

type ContentionReconciliation =
  (typeof CONTENTION_RECONCILIATION)[keyof typeof CONTENTION_RECONCILIATION];

export const DECISION_ROW_WRITE_STATUS = {
  APPLIED: "applied",
  /** The docket's supplements changed after this write composed them. */
  SUPPLEMENTS_MOVED: "supplements-moved",
  WINNER_PENDING: "winner-pending",
  WINNER_REDACTED: "winner-redacted",
  WINNER_SETTLED: "winner-settled",
  /**
   * The row this attempt planned against changed its payload before the
   * write, while this observation still owns it: plan again from the row.
   */
  STALE_PAYLOAD: "stale-payload",
} as const;

export type DecisionRowWriteStatus =
  (typeof DECISION_ROW_WRITE_STATUS)[keyof typeof DECISION_ROW_WRITE_STATUS];

/** One canonical identity plus a small, explicit set of publisher aliases. */
export const MAX_SOURCE_IDENTITY_CANDIDATES = 8;

/**
 * Log event emitted when a source states a decision date the ingestion
 * boundary cannot accept — a non-calendar day or a year outside the range a
 * decision can carry. Reported at WARN: the document is still stored, with
 * no date, and the raw value is carried so the publisher's shape is
 * recoverable without re-fetching.
 */
export const DECISION_DATE_OUT_OF_BOUNDS =
  "case_law.ingestion.decision_date_out_of_bounds";

/** Enough of the rejected value to identify its shape, not a payload. */
export const MAX_LOGGED_DECISION_DATE_LENGTH = 64;

export const DECISION_REFRESH = {
  /**
   * Skip a decision whose source hash and metadata are unchanged: a crawl
   * that re-reads the same document has nothing new to store.
   */
  WHEN_SOURCE_CHANGED: "when-source-changed",
  /**
   * Write the result even when the source hash is unchanged. This is what a
   * re-parse of an already-stored payload needs: the source hash covers the
   * publisher's document, not what a parser derives from it, so a parser
   * that restructures a document without changing its words leaves the hash
   * exactly where it was.
   */
  ALWAYS: "always",
} as const;

export type DecisionRefresh =
  (typeof DECISION_REFRESH)[keyof typeof DECISION_REFRESH];

export type ProcessDecisionAttemptOptions = {
  input: IngestionResult;
  judges: CaseLawJudgeDependencies;
  sourceId: SafeId<"caseLawSource">;
  scopedDb: ScopedDb;
  observedAt: Date;
  observationOrder: bigint;
  contentionReconciliation: ContentionReconciliation;
  refresh: DecisionRefresh;
  corpus: CaseLawCorpusDependencies;
  /**
   * The batch this decision's payloads join. A caller processing a page
   * passes one batch for the page and flushes it when the page is done; a
   * caller with a single decision omits it and the decision is flushed as a
   * batch of its own.
   */
  corpusBatch?: CorpusPackBatch | undefined;
  /**
   * Compiled polarity rules, reused across the decisions of one run. Omitted,
   * each decision reads the rules for its own language once; a crawl passes
   * one cache so the whole cycle reads them once per language.
   */
  polarityRules?: RuleCache | undefined;
};

export type ProcessDecisionOptions = Omit<
  ProcessDecisionAttemptOptions,
  "contentionReconciliation" | "corpus" | "judges" | "refresh"
> & {
  /** Defaults to `WHEN_SOURCE_CHANGED`, which is what a crawl wants. */
  refresh?: DecisionRefresh;
  corpus?: CaseLawCorpusDependencies;
  judges?: CaseLawJudgeDependencies;
};
