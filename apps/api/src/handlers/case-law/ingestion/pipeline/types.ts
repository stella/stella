import type { ScopedDb } from "@/api/db/safe-db";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import type {
  CaseLawCorpusDependencies,
  CaseLawJudgeDependencies,
} from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import type { ProcessResult } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import type { RuleCache } from "@/api/handlers/case-law/polarity/rule-engine";
import type { SafeId } from "@/api/lib/branded-types";
import type { StatedEcliIdentity } from "@/api/lib/legal-search/adapter-manifest";
import type { CorpusPackBatch } from "@/api/lib/legal-search/corpus-pack-batch";
import type { S3CredentialRefreshOptions } from "@/api/lib/s3/credential-guard";

export const CONTENTION_RECONCILIATION = {
  INITIAL: "initial",
  RETRY: "retry",
} as const;

type ContentionReconciliation =
  (typeof CONTENTION_RECONCILIATION)[keyof typeof CONTENTION_RECONCILIATION];

/**
 * What a phase of a decision attempt answers when a concurrent writer moved
 * the row under it. The attempt runs once more from the start; on that second
 * run the same answer holds the page's cursor instead.
 */
export const RECONCILE_CONTENTION = { status: "reconcile-contention" } as const;

/** A phase's answer: the attempt's outcome, or a contention to reconcile. */
export type AttemptStep = ProcessResult | typeof RECONCILE_CONTENTION;

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
// NALUS can name three exact publisher IDs and eight visible/legacy repair digests.
export const MAX_SOURCE_IDENTITY_CANDIDATES = 11;

/**
 * Legacy null-id rows one docket may hold. A docket publishes a handful of
 * documents at most; the bound keeps a pathological docket from loading an
 * unbounded row set inside the identity transaction.
 */
export const MAX_LEGACY_DOCKET_CANDIDATES = 32;

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

/**
 * An observed docket its jurisdiction's grammar does not accept as written:
 * `outcome` says whether ingestion cut a tail from it (`trimmed`), left one
 * because the row is keyed by its docket (`unkeyed`), or found no docket in
 * it at all (`unparsed`).
 */
export const DECISION_DOCKET_NOT_CANONICAL =
  "case_law.ingestion.docket_not_canonical";

export const MAX_LOGGED_DOCKET_LENGTH = 128;

/**
 * A stored decision a publisher reissued under a new document id, recognised
 * by its stated ECLI, docket, date and language: the row now carries the new
 * id, and the old one stays reserved for it.
 */
export const DECISION_REKEYED_BY_ECLI = "case_law.ingestion.decision_rekeyed";

/**
 * More than one stored decision of the source matches the observation's ECLI,
 * docket, date and language, so none is adopted and the observation is stored
 * as a decision of its own.
 */
export const DECISION_ECLI_IDENTITY_AMBIGUOUS =
  "case_law.ingestion.decision_ecli_identity_ambiguous";

/**
 * Stored rows an ECLI can name and still be adopted: one. The lookup reads one
 * more as a sentinel, since a second row is a conflict, not an answer.
 */
export const ECLI_IDENTITY_ADOPTABLE_ROWS = 1;

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
  signal?: AbortSignal;
  s3Policy?: S3CredentialRefreshOptions;
  metadataUrlSchema?: unknown;
  statedEcliIdentity: StatedEcliIdentity;
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
  | "contentionReconciliation"
  | "corpus"
  | "judges"
  | "refresh"
  | "metadataUrlSchema"
  | "statedEcliIdentity"
> & {
  /** Defaults to `WHEN_SOURCE_CHANGED`, which is what a crawl wants. */
  refresh?: DecisionRefresh;
  corpus?: CaseLawCorpusDependencies;
  judges?: CaseLawJudgeDependencies;
};
