export const CORPUS_INDEX_DESIRED_ACTIONS = ["upsert", "erase"] as const;
export type CorpusIndexDesiredAction =
  (typeof CORPUS_INDEX_DESIRED_ACTIONS)[number];

export const CORPUS_INDEX_INTENT_STATUSES = [
  "reserved",
  "append_started",
  // Accepted by the engine; publication is proven separately, and only an
  // exact presence proof moves the revision to `applied`.
  "append_committed",
  "applied",
  "cleanup_pending",
  "cleanup_started",
  "cleanup_committed",
  "cleanup_stalled",
  "settled",
  "cancelled",
  // An offline-delivered revision that an exact census, taken after its
  // indexer had certainly ended, found with no documents. Nothing reached the
  // index, so no delete is owed.
  "withdrawn",
] as const;
export type CorpusIndexIntentStatus =
  (typeof CORPUS_INDEX_INTENT_STATUSES)[number];

/**
 * How a started revision travels to the engine, recorded at its start.
 *
 * - `ingest_api`: one REST ingest request. Its outcome is unknown until the
 *   request answers, so an expired start goes to cleanup.
 * - `offline_indexer`: a local indexer run over a file, killed no later than
 *   `corpusProjectionOfflineIndexerKillDeadline` after the start. Its document
 *   count is stored at the start, so once that deadline has passed one exact
 *   census decides the revision: exact applies it, zero withdraws it, anything
 *   else goes to cleanup.
 */
export const CORPUS_INDEX_APPEND_DELIVERIES = [
  "ingest_api",
  "offline_indexer",
] as const;

/**
 * The most revisions one offline request, one indexer file, may hold. A run
 * pays a process start, a commit and the merges at its exit whatever it
 * carries, so a request should be as large as its bytes allow (the batch
 * sizes by bytes below this); a request of one ingest-sized batch (512) would
 * multiply runs and splits per corpus by sixteen. Sixteen start transactions
 * of at most 512 rows each (`CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE`, the
 * bound on one transaction's row locks, parameters and guard work) cover it
 * inside the offline start window, and a revision that keeps its run from
 * publishing is alone after at most log2(8192) = 13 halvings.
 */
export const CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS = 8192;

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
  withdrawn: "terminal",
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

/**
 * What the index still holds of a revision a projection state names, by the
 * revision's status. Readers address the named revision whatever its status,
 * so this decides whether the entity is served.
 *
 * `intact_until_claimed` is `cleanup_pending`, which holds two cases: a
 * revision preparation or an erasure queued is whole, while one sent back
 * after a cleanup claim (a lost lease, a reissue, a reopened settlement) may
 * already be deleted. Only the cleanup claim increments `cleanup_attempts`,
 * before it can issue a delete, and nothing resets it, so the counter tells
 * the two apart. `never_named`: a state names only an applied revision, and
 * these statuses come before it or instead of it. `withdrawn` is reached only
 * from `append_committed`, which no state names, and the state guard admits
 * naming only an applied revision's history, so it is never named either.
 */
const CORPUS_INDEX_NAMED_REVISION_COPY = {
  reserved: "never_named",
  append_started: "never_named",
  append_committed: "never_named",
  applied: "intact",
  cleanup_pending: "intact_until_claimed",
  cleanup_started: "delete_unproven",
  cleanup_committed: "delete_unproven",
  cleanup_stalled: "delete_unproven",
  settled: "deleted",
  cancelled: "never_named",
  withdrawn: "never_named",
} as const satisfies Record<
  CorpusIndexIntentStatus,
  | "never_named"
  | "intact"
  | "intact_until_claimed"
  | "delete_unproven"
  | "deleted"
>;

type CorpusIndexNamedRevisionCopy =
  (typeof CORPUS_INDEX_NAMED_REVISION_COPY)[CorpusIndexIntentStatus];

export const corpusIndexIntentStatusesWithCopy = (
  copy: CorpusIndexNamedRevisionCopy,
): CorpusIndexIntentStatus[] =>
  CORPUS_INDEX_INTENT_STATUSES.filter(
    (status) => CORPUS_INDEX_NAMED_REVISION_COPY[status] === copy,
  );

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
  "withdrawn",
] as const satisfies readonly CorpusIndexIntentStatus[];

/**
 * The quiescent statuses the outstanding-intent partial index was built to
 * leave out, frozen at that build. A status that became quiescent later
 * (`withdrawn`) stays in the index: the query predicate excludes it, and
 * because every value left out here is also left out there, PostgreSQL still
 * proves the query predicate implies the index's. Rebuilding the index to
 * match would leave a release that asks the older question without its index
 * for the length of the build.
 */
export const CORPUS_INDEX_OUTSTANDING_INDEX_QUIESCENT_STATUSES = [
  "settled",
  "cancelled",
] as const satisfies readonly (typeof CORPUS_INDEX_QUIESCENT_INTENT_STATUSES)[number][];

/**
 * Legal intent transitions. A response lost after an append never returns to
 * `reserved`: its revision is assumed written and must pass through exact
 * cleanup before the same desired epoch can be attempted again.
 */
export const CORPUS_INDEX_INTENT_TRANSITIONS = {
  reserved: ["append_started", "cancelled"],
  append_started: ["append_committed", "cleanup_pending"],
  // `withdrawn`: offline delivery only (the status shape requires it), after
  // a census taken once the indexer had certainly ended counted nothing.
  append_committed: ["applied", "cleanup_pending", "withdrawn"],
  applied: ["cleanup_pending"],
  // `applied` is the cleanup claim's restore of a revision queued while its
  // state still served it and before any delete reached it
  // (`corpusIndexProjectionRevisionIsRestorable`).
  cleanup_pending: ["cleanup_started", "applied"],
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
  // A later census that finds documents of a withdrawn revision disproves the
  // withdrawal the way it disproves a settlement, and reopens it the same way.
  withdrawn: ["cleanup_pending"],
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
