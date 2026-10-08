export const CORPUS_INDEX_DESIRED_ACTIONS = ["upsert", "erase"] as const;
export type CorpusIndexDesiredAction =
  (typeof CORPUS_INDEX_DESIRED_ACTIONS)[number];

export const CORPUS_INDEX_INTENT_STATUSES = [
  "reserved",
  "append_started",
  "append_committed",
  "applied",
  "cleanup_pending",
  "cleanup_started",
  "cleanup_committed",
  "cleanup_stalled",
  "settled",
  "cancelled",
] as const;
export type CorpusIndexIntentStatus =
  (typeof CORPUS_INDEX_INTENT_STATUSES)[number];

/**
 * What a generation-level launch probe must do with each intent state.
 * `applied` still needs the engine census because it may not be the revision
 * referenced by authoritative projection state.
 */
export const CORPUS_INDEX_INTENT_LAUNCH_DISPOSITION = {
  reserved: "blocking",
  append_started: "blocking",
  append_committed: "blocking",
  applied: "census_required",
  cleanup_pending: "blocking",
  cleanup_started: "blocking",
  cleanup_committed: "blocking",
  cleanup_stalled: "blocking",
  settled: "terminal",
  cancelled: "terminal",
} as const satisfies Record<
  CorpusIndexIntentStatus,
  "blocking" | "census_required" | "terminal"
>;

export const CORPUS_INDEX_LAUNCH_BLOCKING_INTENT_STATUSES =
  CORPUS_INDEX_INTENT_STATUSES.filter(
    (status) => CORPUS_INDEX_INTENT_LAUNCH_DISPOSITION[status] === "blocking",
  );

/**
 * Why a reserved revision was cancelled instead of starting its append. The
 * start predicate rejects on the lease deadline or on the desired state, and
 * the two mean opposite things: a run of expiries says a cycle is slower than
 * the lease it takes, a run of desired-state cancellations says the entity
 * changed underneath it. Recording one reason for both hides which happened,
 * so the reason is chosen from the row rather than from the call site.
 */
export const CORPUS_INDEX_APPEND_CANCEL_REASON = {
  leaseExpired: "projection reservation lease expired before append",
  desiredStateChanged: "projection desired state changed before append",
  groupNotAttested: "projection index group was not attested at append start",
} as const;

/** Phases that can create or expose one exact append revision. */
export const CORPUS_INDEX_APPEND_PRODUCING_INTENT_STATUSES = [
  "reserved",
  "append_started",
  "append_committed",
  "applied",
] as const satisfies readonly CorpusIndexIntentStatus[];

/** Append phases whose published document count must already be known. */
export const CORPUS_INDEX_DOCUMENT_COUNT_REQUIRED_INTENT_STATUSES = [
  "append_committed",
  "applied",
] as const satisfies readonly CorpusIndexIntentStatus[];

export const CORPUS_INDEX_PROJECTION_WORK_STATUSES = [
  "eligible",
  "retry_scheduled",
  "repair_scheduled",
  "blocked",
] as const;

export const CORPUS_INDEX_PROJECTION_APPEND_MODES = [
  "batchable",
  "single",
] as const;
export type CorpusIndexProjectionAppendMode =
  (typeof CORPUS_INDEX_PROJECTION_APPEND_MODES)[number];

export const CORPUS_INDEX_PROJECTION_FAILURE_KINDS = [
  "payload_unavailable",
  "revision_too_large",
  "append_unknown",
  "append_rejected",
  "append_transient",
] as const;
export type CorpusIndexProjectionFailureKind =
  (typeof CORPUS_INDEX_PROJECTION_FAILURE_KINDS)[number];

/** Append outcomes that can schedule a retry without charging a revision. */
export const CORPUS_INDEX_PROJECTION_UNCHARGED_RETRY_FAILURE_KINDS = [
  "append_unknown",
  "append_rejected",
  "append_transient",
] as const satisfies readonly CorpusIndexProjectionFailureKind[];

export const CORPUS_INDEX_QUIESCENT_INTENT_STATUSES = [
  "settled",
  "cancelled",
] as const satisfies readonly CorpusIndexIntentStatus[];

/**
 * Legal intent transitions. A response lost after an append never returns to
 * `reserved`: its revision is assumed written and must pass through exact
 * cleanup before the same desired epoch can be attempted again.
 */
export const CORPUS_INDEX_INTENT_TRANSITIONS = {
  reserved: ["append_started", "cancelled"],
  append_started: ["append_committed", "cleanup_pending"],
  append_committed: ["applied", "cleanup_pending"],
  applied: ["cleanup_pending"],
  cleanup_pending: ["cleanup_started"],
  cleanup_started: ["cleanup_pending", "cleanup_committed"],
  // A delete settles unless revisions it targeted were written after it, which
  // no delete can reach: those go back to cleanup for a new delete, a bounded
  // number of times, and then stall for an operator instead of looping.
  cleanup_committed: ["settled", "cleanup_pending", "cleanup_stalled"],
  // Operator-only exit: no worker transition leaves a stall.
  cleanup_stalled: ["cleanup_pending"],
  // A zero-hit census may later disprove settlement if an append was still in
  // an ingester tail. Reopening exact-revision cleanup is safe and makes that
  // engine edge self-healing.
  settled: ["cleanup_pending"],
  cancelled: [],
} as const satisfies Record<
  CorpusIndexIntentStatus,
  readonly CorpusIndexIntentStatus[]
>;

export const canTransitionCorpusIndexIntent = (
  from: CorpusIndexIntentStatus,
  to: CorpusIndexIntentStatus,
): boolean =>
  CORPUS_INDEX_INTENT_TRANSITIONS[from].some((candidate) => candidate === to);

export const corpusIndexIntentStatusAfterUnknownAppend = (
  status: CorpusIndexIntentStatus,
): CorpusIndexIntentStatus =>
  status === "append_started" || status === "append_committed"
    ? "cleanup_pending"
    : status;

type CorpusIndexIntentOutstandingInput = {
  status: CorpusIndexIntentStatus;
  revision: string;
  appliedRevision: string | null;
};

/**
 * `applied` is quiet only while PostgreSQL names that exact revision as
 * authoritative. A crash before the state CAS, or a replaced revision not yet
 * queued for cleanup, remains visible work for the reconciler.
 */
export const isCorpusIndexIntentOutstanding = ({
  status,
  revision,
  appliedRevision,
}: CorpusIndexIntentOutstandingInput): boolean => {
  if (
    CORPUS_INDEX_QUIESCENT_INTENT_STATUSES.some((value) => value === status)
  ) {
    return false;
  }
  return status !== "applied" || revision !== appliedRevision;
};

export type CorpusIndexDesiredProjection =
  | {
      action: "upsert";
      epoch: bigint;
      fingerprint: string;
      indexId: string;
    }
  | { action: "erase"; epoch: bigint };

type CorpusIndexAppliedProjection =
  | { action: "missing" }
  | {
      action: "upsert";
      epoch: bigint;
      fingerprint: string;
      indexId: string;
      revision: string;
    }
  | { action: "erase"; epoch: bigint };

type CorpusIndexConvergenceInput = {
  desired: CorpusIndexDesiredProjection;
  applied: CorpusIndexAppliedProjection;
  /**
   * Every nonterminal intent except the exact revision currently referenced by
   * `applied`. An unreferenced `applied` intent is outstanding cleanup work.
   */
  outstandingIntentCount: number;
};

/**
 * A generation is current for one entity only when PostgreSQL desired and
 * applied state agree and no append or cleanup can still change Quickwit.
 */
export const isCorpusIndexProjectionConverged = ({
  desired,
  applied,
  outstandingIntentCount,
}: CorpusIndexConvergenceInput): boolean => {
  if (outstandingIntentCount !== 0 || applied.action !== desired.action) {
    return false;
  }
  if (desired.action === "erase") {
    return applied.action === "erase" && applied.epoch === desired.epoch;
  }
  return (
    applied.action === "upsert" &&
    applied.epoch === desired.epoch &&
    applied.fingerprint === desired.fingerprint &&
    applied.indexId === desired.indexId
  );
};
