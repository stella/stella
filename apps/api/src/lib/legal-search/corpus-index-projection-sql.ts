import { sql, type SQLWrapper } from "drizzle-orm";

import {
  CORPUS_INDEX_APPEND_PRODUCING_INTENT_STATUSES,
  CORPUS_INDEX_OUTSTANDING_INDEX_QUIESCENT_STATUSES,
  CORPUS_INDEX_QUIESCENT_INTENT_STATUSES,
  type CorpusIndexDesiredAction,
  corpusIndexIntentStatusesWithCopy,
} from "@/api/lib/legal-search/corpus-index-projection-contract";

const sqlLiteralValues = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql.raw(","),
  );

type CorpusProjectionWorkColumns = {
  workStatus: SQLWrapper;
  appliedAction: SQLWrapper;
  desiredAction: SQLWrapper;
  appliedEpoch: SQLWrapper;
  desiredEpoch: SQLWrapper;
  appliedFingerprint: SQLWrapper;
  desiredFingerprint: SQLWrapper;
  appliedIndexId: SQLWrapper;
  desiredIndexId: SQLWrapper;
};

/** One source of truth for the scheduler and its partial queue index. */
export const corpusIndexProjectionNeedsWork = ({
  workStatus,
  appliedAction,
  desiredAction,
  appliedEpoch,
  desiredEpoch,
  appliedFingerprint,
  desiredFingerprint,
  appliedIndexId,
  desiredIndexId,
}: CorpusProjectionWorkColumns) => sql`(
  ${workStatus} = 'repair_scheduled'
  OR (
    ${workStatus} IN ('eligible', 'retry_scheduled')
    AND (
      ${appliedAction} IS NULL
      OR ${appliedAction} IS DISTINCT FROM ${desiredAction}
      OR ${appliedEpoch} IS DISTINCT FROM ${desiredEpoch}
      OR ${appliedFingerprint} IS DISTINCT FROM ${desiredFingerprint}
      OR ${appliedIndexId} IS DISTINCT FROM ${desiredIndexId}
    )
  )
)`;

/**
 * One source of truth for the append queue and its partial index: this row has
 * no earlier revision left in the index. A replacement stays out until its old
 * revision settles, so a claim costs the rows it can take rather than every
 * replacement still waiting its turn. The queue's outstanding-intent probe
 * remains the authority; this only keeps the walk from reaching what it would
 * refuse.
 */
export const corpusIndexProjectionAppendIsUnblocked = ({
  appliedRevision,
  appliedRevisionSettled,
}: {
  appliedRevision: SQLWrapper;
  appliedRevisionSettled: SQLWrapper;
}) => sql`(${appliedRevision} IS NULL OR ${appliedRevisionSettled})`;

export const corpusIndexProjectionIsBlocked = (workStatus: SQLWrapper) =>
  sql`${workStatus} = 'blocked'`;

type CorpusProjectionServedColumns = {
  revisionId: SQLWrapper;
  appliedRevision: SQLWrapper;
  desiredAction: SQLWrapper;
  appliedAction: SQLWrapper;
};

/** Readers are served this revision: an upsert state names it as applied. */
export const corpusIndexProjectionStateServesRevision = ({
  revisionId,
  appliedRevision,
  desiredAction,
  appliedAction,
}: CorpusProjectionServedColumns) => sql`(
  ${appliedRevision} = ${revisionId}
  AND ${desiredAction} = 'upsert'
  AND ${appliedAction} = 'upsert'
)`;

type CorpusProjectionRestoreColumns = CorpusProjectionServedColumns & {
  revisionEpoch: SQLWrapper;
  revisionFingerprint: SQLWrapper;
  revisionIndexId: SQLWrapper;
  cleanupAttempts: SQLWrapper;
  revisionAppliedAt: SQLWrapper;
  lastError: SQLWrapper;
  appliedEpoch: SQLWrapper;
  desiredEpoch: SQLWrapper;
  desiredFingerprint: SQLWrapper;
  desiredIndexId: SQLWrapper;
};

/**
 * A `cleanup_pending` revision that may return to `applied`: its state still
 * serves it, and the copy readers are served is provably the one it held.
 *
 * - `cleanup_attempts = 0`: no claim ever took it, and only a claim leads to
 *   an engine delete (the claim counts the attempt before the delete is sent,
 *   and the count never decreases).
 * - `last_error IS NULL` and `applied_at IS NOT NULL`: replacement
 *   preparation queued it from `applied`; erasure, drift repair and every
 *   other cleanup writer record why.
 * - and either of:
 *   - `desired_epoch = epoch + 1`: exactly one desired change separates the
 *     revision from the desired state. The state guard admits a change of the
 *     desired action, fingerprint or index only at a strictly newer epoch, so
 *     an erasure and its undo take two epochs, and preparation queued the
 *     revision only once the desired epoch had passed it, so no change came
 *     after the queueing;
 *   - the desired fingerprint and index equal the revision's: the copy holds
 *     exactly what the state desires, whatever came in between.
 *
 * Anything else is not restored. That includes a revision with
 * `last_error` set whose content equals the desired value (an earlier
 * release's erasure fence or drift repair, followed by an undo back to the
 * same content): the claim deletes it as `served_unproven` and the entity is
 * appended anew after settlement. Restoring it would need `last_error` to
 * stop singling out preparation, so the small class is left to the
 * conservative direction on purpose. The database guard on
 * `cleanup_pending -> applied` repeats this predicate.
 */
export const corpusIndexProjectionRevisionIsRestorable = ({
  revisionEpoch,
  revisionFingerprint,
  revisionIndexId,
  cleanupAttempts,
  revisionAppliedAt,
  lastError,
  appliedEpoch,
  desiredEpoch,
  desiredFingerprint,
  desiredIndexId,
  ...served
}: CorpusProjectionRestoreColumns) => sql`(
  ${corpusIndexProjectionStateServesRevision(served)}
  AND ${cleanupAttempts} = 0
  AND ${revisionAppliedAt} IS NOT NULL
  AND ${lastError} IS NULL
  AND ${appliedEpoch} = ${revisionEpoch}
  AND ${desiredEpoch} > ${revisionEpoch}
  AND (
    ${desiredEpoch} = ${revisionEpoch} + 1
    OR (
      ${desiredFingerprint} = ${revisionFingerprint}
      AND ${desiredIndexId} = ${revisionIndexId}
    )
  )
)`;

type CorpusProjectionNamedCopyColumns = {
  desiredAction: SQLWrapper;
  appliedAction: SQLWrapper;
  appliedRevision: SQLWrapper;
  appliedEpoch: SQLWrapper;
  desiredEpoch: SQLWrapper;
  appliedFingerprint: SQLWrapper;
  desiredFingerprint: SQLWrapper;
  appliedIndexId: SQLWrapper;
  desiredIndexId: SQLWrapper;
};

/**
 * An upsert state names an upsert copy that two or more desired changes
 * separate from the desired state, and the copy holds other content than the
 * state desires: a superseded copy that is not provably current, since an
 * erasure and its undo also take two changes.
 *
 * An upsert write by the desired writer leaves `desired_at` unchanged once a
 * state is in this shape, so from then on it records when the copy fell this
 * far behind and no later upsert write (an epoch-only reconciliation, a
 * ranking-signal re-projection, another content change) moves it past the
 * one-off pass's cutover. The pass (`retireLegacyUnprovenServedCopiesTx`)
 * considers such a copy only when that instant precedes the cutover, and
 * retires it only with a recorded erasure. Both go together once the pass has
 * run.
 */
export const corpusIndexProjectionNamedCopyTrailsTwoChanges = ({
  desiredAction,
  appliedAction,
  appliedRevision,
  appliedEpoch,
  desiredEpoch,
  appliedFingerprint,
  desiredFingerprint,
  appliedIndexId,
  desiredIndexId,
}: CorpusProjectionNamedCopyColumns) => sql`(
  ${desiredAction} = 'upsert'
  AND ${appliedAction} = 'upsert'
  AND ${appliedRevision} IS NOT NULL
  AND ${desiredEpoch} >= ${appliedEpoch} + 2
  AND (${desiredFingerprint}, ${desiredIndexId})
    IS DISTINCT FROM (${appliedFingerprint}, ${appliedIndexId})
)`;

/**
 * One source of truth for "a queued cleanup may be claimed now": its fence has
 * passed and no lease holds it. Shared by the claim's unlocked page and the row
 * lock that follows it, because a row can leave the queue and return with a
 * later fence in between, and the lock must not claim it early.
 */
export const corpusIndexProjectionCleanupIsDue = ({
  cleanupNotBefore,
  leaseExpiresAt,
}: {
  cleanupNotBefore: SQLWrapper;
  leaseExpiresAt: SQLWrapper;
}) => sql`(
  ${cleanupNotBefore} <= clock_timestamp()
  AND (${leaseExpiresAt} IS NULL OR ${leaseExpiresAt} <= clock_timestamp())
)`;

/** One source of truth for the partial append-epoch uniqueness boundary. */
export const corpusIndexProjectionProducesAppend = (status: SQLWrapper) =>
  sql`${status} IN (${sqlLiteralValues(CORPUS_INDEX_APPEND_PRODUCING_INTENT_STATUSES)})`;

/**
 * One source of truth for "this entity still owes the index an exact action",
 * shared by the append and erasure anti-joins. The partial index that answers
 * them leaves out a subset of these statuses
 * (`corpusIndexProjectionOutstandingIndexPredicate`), so PostgreSQL proves
 * this predicate implies the index's and the probe never walks an entity's
 * settled or cancelled history, however long it grows.
 */
export const corpusIndexProjectionIntentIsOutstanding = (status: SQLWrapper) =>
  sql`${status} NOT IN (${sqlLiteralValues(CORPUS_INDEX_QUIESCENT_INTENT_STATUSES)})`;

/** The outstanding-intent partial index's own predicate, as it was built. */
export const corpusIndexProjectionOutstandingIndexPredicate = (
  status: SQLWrapper,
) =>
  sql`${status} NOT IN (${sqlLiteralValues(CORPUS_INDEX_OUTSTANDING_INDEX_QUIESCENT_STATUSES)})`;

const ERASE_ACTION: CorpusIndexDesiredAction = "erase";
const ERASE_ACTION_LITERAL = sql.raw(`'${ERASE_ACTION}'`);
const UPSERT_ACTION: CorpusIndexDesiredAction = "upsert";
const UPSERT_ACTION_LITERAL = sql.raw(`'${UPSERT_ACTION}'`);

type CorpusProjectionRevisionCopyColumns = {
  status: SQLWrapper;
  cleanupAttempts: SQLWrapper;
};

const statusHasCopy = (
  status: SQLWrapper,
  copy: Parameters<typeof corpusIndexIntentStatusesWithCopy>[0],
) =>
  sql`${status} IN (${sqlLiteralValues(corpusIndexIntentStatusesWithCopy(copy))})`;

/**
 * A delete of this revision may have been issued and is not proven yet: it is
 * at or past the cleanup claim (`CORPUS_INDEX_NAMED_REVISION_COPY`), short of
 * settlement. One source of truth for the at-risk branch and the partial
 * intent index that answers it.
 */
export const corpusIndexProjectionRevisionDeleteIsUnproven = ({
  status,
  cleanupAttempts,
}: CorpusProjectionRevisionCopyColumns) => sql`(
  ${statusHasCopy(status, "delete_unproven")}
  OR (${statusHasCopy(status, "intact_until_claimed")} AND ${cleanupAttempts} > 0)
)`;

const revisionCopyIsIntact = ({
  status,
  cleanupAttempts,
}: CorpusProjectionRevisionCopyColumns) => sql`(
  ${statusHasCopy(status, "intact")}
  OR (${statusHasCopy(status, "intact_until_claimed")} AND ${cleanupAttempts} = 0)
)`;

type CorpusProjectionServingStateColumns = {
  desiredAction: SQLWrapper;
  appliedAction: SQLWrapper;
  appliedRevision: SQLWrapper;
  appliedRevisionSettled: SQLWrapper;
};

type CorpusProjectionServingColumns = {
  state: CorpusProjectionServingStateColumns;
  /** The revision `applied_revision` names, joined by its primary key. */
  revision: CorpusProjectionRevisionCopyColumns;
};

const wantsUpsert = (desiredAction: SQLWrapper) =>
  sql`${desiredAction} = ${UPSERT_ACTION_LITERAL}`;

/**
 * A named revision means an applied upsert (the states table's `applied_shape`
 * check), so the predicate does not restate the action: restating it would
 * match the partial census index and steer a lookup off the primary key.
 */
const namesLiveRevision = ({
  appliedRevision,
  appliedRevisionSettled,
}: CorpusProjectionServingStateColumns) =>
  sql`${appliedRevision} IS NOT NULL AND NOT ${appliedRevisionSettled}`;

/** The absent branch on the state row alone, shared with its partial index. */
export const corpusIndexProjectionIsAbsent = ({
  desiredAction,
  appliedAction,
  appliedRevisionSettled,
}: Omit<CorpusProjectionServingStateColumns, "appliedRevision">) => sql`(
  ${wantsUpsert(desiredAction)}
  AND (${appliedAction} = ${ERASE_ACTION_LITERAL} OR ${appliedRevisionSettled})
)`;

/**
 * Whether readers can reach a copy of the entity. Readers address the revision
 * `applied_revision` names, whatever its status, so the entity is served
 * exactly while that revision's copy is whole.
 *
 * - `served`: an upsert is wanted and the named copy is whole: applied, or
 *   queued for cleanup with no delete issued. A newer upsert may be queued;
 *   the old copy answers.
 * - `at_risk`: an upsert is wanted and a delete of the named copy may have
 *   been issued, not yet proven. The copy vanishes once the engine applies
 *   the delete.
 * - `absent`: an upsert is wanted and nothing answers: the named revision's
 *   delete settled, or an erasure applied before the upsert came back.
 * - `never_applied`: an upsert is wanted and nothing was ever applied: a new
 *   entity on its first append. Expected lag, not a defect.
 * - `erased`: an erasure is wanted, so nothing should be served.
 *
 * The branches are disjoint and together total over the states table's
 * checks, so each stands alone. `absent` reads the state row alone
 * (`applied_revision_settled` is trigger-kept equal to the named revision
 * having settled), so a partial index can carry it; `at_risk` needs the named
 * revision, whose own partial index carries it. Actions are literals for the
 * reason `corpusIndexProjectionErasureIsPending` gives.
 */
export const CORPUS_INDEX_PROJECTION_SERVING = {
  served: ({ state, revision }: CorpusProjectionServingColumns) => sql`(
    ${wantsUpsert(state.desiredAction)}
    AND ${namesLiveRevision(state)}
    AND ${revisionCopyIsIntact(revision)}
  )`,
  at_risk: ({ state, revision }: CorpusProjectionServingColumns) => sql`(
    ${wantsUpsert(state.desiredAction)}
    AND ${namesLiveRevision(state)}
    AND ${corpusIndexProjectionRevisionDeleteIsUnproven(revision)}
  )`,
  absent: ({ state }: CorpusProjectionServingColumns) =>
    corpusIndexProjectionIsAbsent(state),
  never_applied: ({ state }: CorpusProjectionServingColumns) => sql`(
    ${wantsUpsert(state.desiredAction)}
    AND ${state.appliedAction} IS NULL
  )`,
  erased: ({ state }: CorpusProjectionServingColumns) =>
    sql`(${state.desiredAction} = ${ERASE_ACTION_LITERAL})`,
} as const;

export type CorpusIndexProjectionServing =
  keyof typeof CORPUS_INDEX_PROJECTION_SERVING;

type CorpusProjectionErasureColumns = {
  appliedAction: SQLWrapper;
  appliedEpoch: SQLWrapper;
  desiredAction: SQLWrapper;
  desiredEpoch: SQLWrapper;
};

/**
 * One source of truth for "this entity still owes the index an erasure",
 * shared by the erasure claim and by the partial index that serves it. The
 * action is written as a literal rather than bound: PostgreSQL uses a partial
 * index only where it can prove the index predicate from the query's, and a
 * generic plan over `desired_action = $n` proves nothing, so the claim would
 * read the whole table however few erasures are pending.
 */
export const corpusIndexProjectionErasureIsPending = ({
  appliedAction,
  appliedEpoch,
  desiredAction,
  desiredEpoch,
}: CorpusProjectionErasureColumns) => sql`(
  ${desiredAction} = ${ERASE_ACTION_LITERAL}
  AND (
    ${appliedAction} IS DISTINCT FROM ${ERASE_ACTION_LITERAL}
    OR ${appliedEpoch} IS DISTINCT FROM ${desiredEpoch}
  )
)`;
