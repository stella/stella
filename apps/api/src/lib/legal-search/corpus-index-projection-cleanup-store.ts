import { panic, Result } from "better-result";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  min,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockCorpusProjectionServingStatesForCleanup,
  lockCorpusProjectionStatesOfRevisions,
  lockPendingCorpusProjectionCleanups,
} from "@/api/lib/db/aggregate-lock";
import { transitionBatch } from "@/api/lib/db/transitions";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import type {
  CorpusIndexClient,
  CorpusIndexDeleteSettlementRead,
  CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import { corpusIndexMaturationPeriodMs } from "@/api/lib/legal-search/corpus-index-config";
import {
  type CorpusIndexManifest,
  requireCorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  CORPUS_INDEX_APPEND_CANCEL_REASON,
  type CorpusIndexIntentStatus,
} from "@/api/lib/legal-search/corpus-index-projection-contract";
import { lockRegisteredCorpusProjectionManifestForMutation } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
  countCorpusProjectionRevisions,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import { CORPUS_INDEX_PROJECTION_INTENT_LIFECYCLE } from "@/api/lib/legal-search/corpus-index-projection-intent-transition-spec";
import { corpusProjectionAppendPublishBarrier } from "@/api/lib/legal-search/corpus-index-projection-publish-fence";
import {
  lockCorpusIndexProjectionIntentMutationsTx,
  lockCorpusIndexProjectionMutationsTx,
} from "@/api/lib/legal-search/corpus-index-projection-revision";
import {
  CORPUS_PROJECTION_GENERATION_SCOPE,
  type CorpusProjectionScopedWorkOptions,
  entityIdsForCorpusProjectionWorkScope,
} from "@/api/lib/legal-search/corpus-index-projection-scope";
import {
  type CorpusProjectionCleanupJudgement,
  type CorpusProjectionCleanupPending,
  judgeCorpusProjectionCleanupSettlement,
} from "@/api/lib/legal-search/corpus-index-projection-settlement-judgement";
import {
  corpusIndexProjectionCleanupIsDue,
  corpusIndexProjectionIntentIsOutstanding,
  corpusIndexProjectionRevisionIsRestorable,
  corpusIndexProjectionStateServesRevision,
} from "@/api/lib/legal-search/corpus-index-projection-sql";
import {
  CORPUS_PROJECTION_APPEND_RETRY_BASE_MS,
  CORPUS_PROJECTION_APPEND_RETRY_CAP_MS,
  CORPUS_PROJECTION_APPEND_UNKNOWN_ATTEMPT_LIMIT,
  CORPUS_PROJECTION_LEASE_MAX_MS,
  CORPUS_PROJECTION_LEASE_MIN_MS,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import { logger } from "@/api/lib/observability/logger";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

type ProjectionIntentId = SafeId<"corpusIndexProjectionIntent">;

const CORPUS_PROJECTION_REOPEN_CONVERGED_STATUSES = [
  "cleanup_pending",
  "cleanup_started",
  "cleanup_committed",
  "cleanup_stalled",
] as const satisfies readonly CorpusIndexIntentStatus[];
/** Revisions an absent census expects gone; one it observes reopens. */
const CORPUS_PROJECTION_REOPEN_FROM_STATUSES = [
  "settled",
  "withdrawn",
] as const satisfies readonly CorpusIndexIntentStatus[];
const CORPUS_PROJECTION_REOPENABLE_STATUSES = [
  ...CORPUS_PROJECTION_REOPEN_CONVERGED_STATUSES,
  ...CORPUS_PROJECTION_REOPEN_FROM_STATUSES,
] as const satisfies readonly CorpusIndexIntentStatus[];
const CORPUS_PROJECTION_REOPEN_CONVERGED_STATUS_SET =
  new Set<CorpusIndexIntentStatus>(CORPUS_PROJECTION_REOPEN_CONVERGED_STATUSES);

const validateCleanupBatchSize = (limit: number): number => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CORPUS_PROJECTION_DELETE_MAX_REVISIONS
  ) {
    return panic(
      `Corpus projection cleanup batch size must be an integer from 1 to ${CORPUS_PROJECTION_DELETE_MAX_REVISIONS}`,
    );
  }
  return limit;
};

const validateLeaseMs = (leaseMs: number): number => {
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < CORPUS_PROJECTION_LEASE_MIN_MS ||
    leaseMs > CORPUS_PROJECTION_LEASE_MAX_MS
  ) {
    return panic(
      `Corpus projection lease must be an integer from ${CORPUS_PROJECTION_LEASE_MIN_MS} to ${CORPUS_PROJECTION_LEASE_MAX_MS} milliseconds`,
    );
  }
  return leaseMs;
};

const lockCorpusProjectionIntentsById = async (
  tx: Transaction,
  intentIds: readonly ProjectionIntentId[],
): Promise<void> => {
  await tx
    .select({ id: corpusIndexProjectionIntents.id })
    .from(corpusIndexProjectionIntents)
    .where(inArray(corpusIndexProjectionIntents.id, intentIds))
    .orderBy(asc(corpusIndexProjectionIntents.id))
    .limit(intentIds.length)
    .for("update");
};

type CorpusProjectionCleanupLease = {
  intentId: ProjectionIntentId;
  family: CorpusFamily;
  generation: string;
  entityId: string;
  indexId: string;
  leaseToken: string;
};

type ClaimCorpusProjectionCleanupOptions<Family extends CorpusFamily> =
  CorpusProjectionScopedWorkOptions<Family> & {
    generation: string;
    indexId: string;
    limit: number;
    leaseMs: number;
    testNow?: Date;
    newLeaseToken?: () => string;
  };

/**
 * Why the claim took a revision. Only `unserved` is the ordinary case: no
 * upsert state names the revision, so deleting it hides nothing. The other two
 * delete a copy an upsert state still names, and exist only for rows an
 * earlier release left behind (it queued served revisions for cleanup); no
 * writer in this release creates one, so both only shrink:
 *
 * - `served_after_delete`: a delete may already have been issued, so the copy
 *   may already be gone and holding the cleanup back would only keep the
 *   entity hidden. It settles and the entity is appended again.
 * - `served_unproven`: never claimed, but more than one desired change
 *   separates it from the desired state, so an erasure undone in between
 *   cannot be ruled out and the copy may be the pre-erasure one. Deleting it
 *   is the safe direction; the entity is appended anew.
 */
const CORPUS_PROJECTION_CLEANUP_CLAIM_KINDS = [
  "unserved",
  "served_after_delete",
  "served_unproven",
] as const;
type CorpusProjectionCleanupClaimKind =
  (typeof CORPUS_PROJECTION_CLEANUP_CLAIM_KINDS)[number];

const CLEANUP_CANDIDATE_RESTORE = "restore";
const CORPUS_PROJECTION_CLEANUP_DISPOSITIONS = [
  CLEANUP_CANDIDATE_RESTORE,
  ...CORPUS_PROJECTION_CLEANUP_CLAIM_KINDS,
] as const;
type CorpusProjectionCleanupDisposition =
  (typeof CORPUS_PROJECTION_CLEANUP_DISPOSITIONS)[number];

const requireCleanupDisposition = (
  value: unknown,
): CorpusProjectionCleanupDisposition =>
  CORPUS_PROJECTION_CLEANUP_DISPOSITIONS.find(
    (disposition) => disposition === value,
  ) ?? panic(`Unknown corpus projection cleanup disposition: ${String(value)}`);

export type CorpusProjectionCleanupClaim = {
  leases: CorpusProjectionCleanupLease[];
  /** Leases per kind; the counts sum to `leases.length`. */
  claimed: Record<CorpusProjectionCleanupClaimKind, number>;
  /** Served revisions no delete reached, returned to `applied` instead. */
  restoredIntentIds: ProjectionIntentId[];
  /**
   * Candidates the turn read but left queued: another transaction held the
   * revision or its serving state, or the revision stopped being due before
   * it was locked. A later turn reaches them again. The claim never waits on
   * a lock.
   */
  skippedLocked: number;
};

type CorpusProjectionCleanupPageOptions = {
  family: CorpusFamily;
  generation: string;
  indexId: string;
  limit: number;
  scopedEntityIds: readonly string[] | null;
  /** Candidates an earlier page of the same turn already read. */
  excludedIntentIds: readonly ProjectionIntentId[];
};

/**
 * The cleanup claim's walk: the next `limit` revisions in queue order, each
 * with the state that serves it, if any (one probe of the applied-revision
 * unique index). Unlocked: every row it returns leaves the queue or is
 * reported skipped in this turn, so the walk costs the pages it reads.
 * Exported so the plan guard explains the exact statement the claim issues.
 */
export const corpusProjectionCleanupClaimPage = (
  tx: Transaction,
  {
    family,
    generation,
    indexId,
    limit,
    scopedEntityIds,
    excludedIntentIds,
  }: CorpusProjectionCleanupPageOptions,
) =>
  tx
    .select({
      id: corpusIndexProjectionIntents.id,
      entityId: corpusIndexProjectionIntents.entityId,
      servingEntityId: corpusIndexProjectionStates.entityId,
    })
    .from(corpusIndexProjectionIntents)
    .leftJoin(
      corpusIndexProjectionStates,
      eq(
        corpusIndexProjectionStates.appliedRevision,
        corpusIndexProjectionIntents.id,
      ),
    )
    .where(
      and(
        eq(corpusIndexProjectionIntents.family, family),
        eq(corpusIndexProjectionIntents.generation, generation),
        eq(corpusIndexProjectionIntents.indexId, indexId),
        scopedEntityIds === null
          ? undefined
          : inArray(corpusIndexProjectionIntents.entityId, scopedEntityIds),
        excludedIntentIds.length === 0
          ? undefined
          : notInArray(corpusIndexProjectionIntents.id, [...excludedIntentIds]),
        eq(corpusIndexProjectionIntents.status, "cleanup_pending"),
        corpusIndexProjectionCleanupIsDue({
          cleanupNotBefore: corpusIndexProjectionIntents.cleanupNotBefore,
          leaseExpiresAt: corpusIndexProjectionIntents.leaseExpiresAt,
        }),
      ),
    )
    .orderBy(
      asc(corpusIndexProjectionIntents.cleanupNotBefore),
      asc(corpusIndexProjectionIntents.createdAt),
    )
    .limit(limit);

const noCleanupClaims = () =>
  ({
    unserved: 0,
    served_after_delete: 0,
    served_unproven: 0,
  }) satisfies Record<CorpusProjectionCleanupClaimKind, number>;

type CleanupPageRow = Awaited<
  ReturnType<typeof corpusProjectionCleanupClaimPage>
>[number];

type LockDecidableCleanupPageOptions = {
  family: CorpusFamily;
  generation: string;
  page: readonly CleanupPageRow[];
};

/**
 * Lock the page's serving states, then the revisions whose serving is decidable:
 * those no state serves, and those whose state this transaction now holds.
 */
const lockDecidableCleanupPageTx = async (
  tx: Transaction,
  { family, generation, page }: LockDecidableCleanupPageOptions,
) => {
  const servingEntityIds = [
    ...new Set(
      page.flatMap(({ servingEntityId }) =>
        servingEntityId === null ? [] : [servingEntityId],
      ),
    ),
  ];
  const heldStates =
    servingEntityIds.length === 0
      ? []
      : await lockCorpusProjectionServingStatesForCleanup(tx, {
          family,
          generation,
          entityIds: servingEntityIds,
        });
  const heldEntityIds = new Set(heldStates.map(({ entityId }) => entityId));
  const decidable = page.filter(
    ({ servingEntityId }) =>
      servingEntityId === null || heldEntityIds.has(servingEntityId),
  );
  const locked =
    decidable.length === 0
      ? []
      : await lockPendingCorpusProjectionCleanups(
          tx,
          decidable.map(({ id }) => id),
        );
  return {
    decidable: locked.map(({ id }) => id),
    skippedLocked: page.length - locked.length,
  };
};

/**
 * Pages one claim turn reads at most. A page whose candidates are all held
 * elsewhere would otherwise fill the turn with nothing and keep heading the
 * queue; each further page reads past what the turn already saw.
 */
const CLEANUP_CLAIM_MAX_PAGES = 4;

type LockCleanupCandidatesOptions = Omit<
  CorpusProjectionCleanupPageOptions,
  "excludedIntentIds"
>;

/**
 * Read and lock the turn's candidates, page after page, until `limit` are
 * decidable, the queue runs out, or `CLEANUP_CLAIM_MAX_PAGES` were read.
 */
const lockCleanupCandidatesTx = async (
  tx: Transaction,
  options: LockCleanupCandidatesOptions,
) => {
  const decidable: ProjectionIntentId[] = [];
  const seen: ProjectionIntentId[] = [];
  let skippedLocked = 0;
  for (let page = 0; page < CLEANUP_CLAIM_MAX_PAGES; page += 1) {
    const wanted = options.limit - decidable.length;
    // db-await-in-loop: each page starts past the rows the previous one read
    const rows = await corpusProjectionCleanupClaimPage(tx, {
      ...options,
      limit: wanted,
      excludedIntentIds: seen,
    });
    seen.push(...rows.map(({ id }) => id));
    // db-await-in-loop: locks follow the page they decide
    const locked = await lockDecidableCleanupPageTx(tx, {
      family: options.family,
      generation: options.generation,
      page: rows,
    });
    decidable.push(...locked.decidable);
    skippedLocked += locked.skippedLocked;
    if (rows.length < wanted || decidable.length >= options.limit) {
      break;
    }
  }
  return { decidable, skippedLocked };
};

/** Each locked candidate's disposition, read under the locks just taken. */
const decideCleanupCandidatesTx = async (
  tx: Transaction,
  intentIds: readonly ProjectionIntentId[],
) => {
  if (intentIds.length === 0) {
    return [];
  }
  const served = {
    revisionId: corpusIndexProjectionIntents.id,
    appliedRevision: corpusIndexProjectionStates.appliedRevision,
    desiredAction: corpusIndexProjectionStates.desiredAction,
    appliedAction: corpusIndexProjectionStates.appliedAction,
  };
  const rows = await tx
    .select({
      id: corpusIndexProjectionIntents.id,
      entityId: corpusIndexProjectionIntents.entityId,
      disposition: sql<string>`CASE
        WHEN ${corpusIndexProjectionStateServesRevision(served)} IS NOT TRUE
          THEN ${"unserved" satisfies CorpusProjectionCleanupDisposition}
        WHEN ${corpusIndexProjectionRevisionIsRestorable({
          ...served,
          revisionEpoch: corpusIndexProjectionIntents.epoch,
          cleanupAttempts: corpusIndexProjectionIntents.cleanupAttempts,
          revisionAppliedAt: corpusIndexProjectionIntents.appliedAt,
          lastError: corpusIndexProjectionIntents.lastError,
          appliedEpoch: corpusIndexProjectionStates.appliedEpoch,
          desiredEpoch: corpusIndexProjectionStates.desiredEpoch,
        })}
          THEN ${CLEANUP_CANDIDATE_RESTORE satisfies CorpusProjectionCleanupDisposition}
        WHEN ${corpusIndexProjectionIntents.cleanupAttempts} > 0
          THEN ${"served_after_delete" satisfies CorpusProjectionCleanupDisposition}
        ELSE ${"served_unproven" satisfies CorpusProjectionCleanupDisposition}
      END`,
    })
    .from(corpusIndexProjectionIntents)
    .leftJoin(
      corpusIndexProjectionStates,
      eq(
        corpusIndexProjectionStates.appliedRevision,
        corpusIndexProjectionIntents.id,
      ),
    )
    .where(inArray(corpusIndexProjectionIntents.id, [...intentIds]))
    .orderBy(asc(corpusIndexProjectionIntents.id))
    .limit(intentIds.length);
  return rows.map((row) => ({
    id: row.id,
    entityId: row.entityId,
    disposition: requireCleanupDisposition(row.disposition),
  }));
};

type RestoreServedRevisionsOptions = {
  intentIds: readonly ProjectionIntentId[];
  claimAt: Date | SQL<Date>;
};

/**
 * Return served revisions no delete reached to `applied`. The columns are
 * the ones the revision held while applied: preparation only queued it, and
 * the publish barrier and every append instant are immutable.
 */
const restoreServedRevisionsTx = async (
  tx: Transaction,
  { intentIds, claimAt }: RestoreServedRevisionsOptions,
): Promise<void> => {
  if (intentIds.length === 0) {
    return;
  }
  const restored = await transitionBatch({
    tx,
    spec: CORPUS_INDEX_PROJECTION_INTENT_LIFECYCLE,
    ids: intentIds,
    options: {
      to: "applied",
      from: ["cleanup_pending"],
      set: {
        leaseToken: null,
        leaseExpiresAt: null,
        cleanupNotBefore: null,
        lastError: null,
        updatedAt: claimAt,
      },
    },
    // Bookkeeping on the derived public corpus projection: no tenant data
    // and no actor; the claim's telemetry reports restores.
    recordTransitionAuditEvent: () => undefined,
  });
  if (restored.length !== intentIds.length) {
    return panic(
      `Corpus projection cleanup restored ${restored.length} of ${intentIds.length} revisions`,
    );
  }
};

/**
 * Claim the next cleanup batch of one index. Cleanup never deletes the copy an
 * upsert state serves, except the two kinds `CORPUS_PROJECTION_CLEANUP_CLAIM_KINDS`
 * names; a served revision no delete reached is restored instead.
 *
 * Lock order is the projection order: mutation fence, manifest, then the
 * serving states by entity, then the revisions by id. Both row locks skip
 * what another transaction holds, so the claim never waits on a row and
 * cannot close a lock cycle with any writer. Whether a revision is served is
 * decided under its state's lock: nothing can start naming a
 * `cleanup_pending` revision (only `append_committed -> applied` names one),
 * so a revision the page saw unserved stays unserved, and one it saw served
 * is re-read once its state is held.
 */
export const claimCorpusProjectionCleanupTx = async <
  Family extends CorpusFamily,
>(
  tx: Transaction,
  {
    family,
    generation,
    indexId,
    limit: requestedLimit,
    leaseMs: requestedLeaseMs,
    scope = CORPUS_PROJECTION_GENERATION_SCOPE,
    testNow,
    newLeaseToken = () => Bun.randomUUIDv7(),
  }: ClaimCorpusProjectionCleanupOptions<Family>,
): Promise<CorpusProjectionCleanupClaim> => {
  const limit = validateCleanupBatchSize(requestedLimit);
  const leaseMs = validateLeaseMs(requestedLeaseMs);
  const scopedEntityIds = entityIdsForCorpusProjectionWorkScope(scope);
  await lockRegisteredCorpusProjectionManifestForMutation(
    tx,
    family,
    generation,
  );
  const { decidable, skippedLocked } = await lockCleanupCandidatesTx(tx, {
    family,
    generation,
    indexId,
    limit,
    scopedEntityIds,
  });
  const decided = await decideCleanupCandidatesTx(tx, decidable);
  const claimAt = testNow ?? sql<Date>`clock_timestamp()`;
  const restoredIntentIds = decided
    .filter(({ disposition }) => disposition === CLEANUP_CANDIDATE_RESTORE)
    .map(({ id }) => id);
  await restoreServedRevisionsTx(tx, { intentIds: restoredIntentIds, claimAt });
  const toClaim = decided.flatMap(({ id, entityId, disposition }) =>
    disposition === CLEANUP_CANDIDATE_RESTORE
      ? []
      : [{ id, entityId, kind: disposition }],
  );
  const claimed = noCleanupClaims();
  for (const { kind } of toClaim) {
    claimed[kind] += 1;
  }
  const leaseToken = newLeaseToken();
  if (toClaim.length > 0) {
    const leaseExpiresAt =
      testNow === undefined
        ? sql<Date>`clock_timestamp() + ${leaseMs} * INTERVAL '1 millisecond'`
        : new Date(testNow.getTime() + leaseMs);
    const updated = await tx
      .update(corpusIndexProjectionIntents)
      .set({
        status: "cleanup_started",
        leaseToken,
        leaseExpiresAt,
        cleanupStartedAt: claimAt,
        cleanupAttempts: sql`${corpusIndexProjectionIntents.cleanupAttempts} + 1`,
        updatedAt: claimAt,
      })
      .where(
        and(
          inArray(
            corpusIndexProjectionIntents.id,
            toClaim.map(({ id }) => id),
          ),
          eq(corpusIndexProjectionIntents.status, "cleanup_pending"),
        ),
      )
      .returning({ id: corpusIndexProjectionIntents.id });
    if (updated.length !== toClaim.length) {
      return panic(
        `Corpus projection cleanup claimed ${updated.length} of ${toClaim.length} revisions`,
      );
    }
  }
  if (
    restoredIntentIds.length > 0 ||
    claimed.served_after_delete > 0 ||
    claimed.served_unproven > 0
  ) {
    logger.warn("corpus_projection.cleanup_served_revisions", {
      family,
      generation,
      index: indexId,
      restored: restoredIntentIds.length,
      claimed_after_delete: claimed.served_after_delete,
      claimed_unproven: claimed.served_unproven,
    });
  }
  return {
    leases: toClaim.map(({ id, entityId }) => ({
      intentId: id,
      family,
      generation,
      entityId,
      indexId,
      leaseToken,
    })),
    claimed,
    restoredIntentIds,
    skippedLocked,
  };
};

type RecordCorpusProjectionDeleteOptions = {
  intentIds: readonly ProjectionIntentId[];
  indexId: string;
  leaseToken: string;
  deleteOpstamp: number;
  /** The metastore's creation instant for the delete task, from its receipt. */
  deleteTaskCreatedAt: Temporal.Instant;
  testNow?: Date;
};

export const recordCorpusProjectionDeleteTx = async (
  tx: Transaction,
  {
    intentIds,
    indexId,
    leaseToken,
    deleteOpstamp,
    deleteTaskCreatedAt,
    testNow,
  }: RecordCorpusProjectionDeleteOptions,
): Promise<number> => {
  if (
    intentIds.length === 0 ||
    intentIds.length > CORPUS_PROJECTION_DELETE_MAX_REVISIONS ||
    !Number.isSafeInteger(deleteOpstamp) ||
    deleteOpstamp < 0
  ) {
    return panic("Corpus projection delete receipt is invalid");
  }
  await lockCorpusIndexProjectionIntentMutationsTx(tx, intentIds);
  await lockCorpusProjectionIntentsById(tx, intentIds);
  const transitionAt = testNow ?? sql<Date>`clock_timestamp()`;
  const rows = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cleanup_committed",
      leaseToken: null,
      leaseExpiresAt: null,
      deleteOpstamp: BigInt(deleteOpstamp),
      deleteTaskCreatedAt: new Date(deleteTaskCreatedAt.epochMilliseconds),
      lastError: null,
      updatedAt: transitionAt,
    })
    .where(
      and(
        inArray(corpusIndexProjectionIntents.id, intentIds),
        eq(corpusIndexProjectionIntents.indexId, indexId),
        eq(corpusIndexProjectionIntents.status, "cleanup_started"),
        eq(corpusIndexProjectionIntents.leaseToken, leaseToken),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  if (rows.length !== intentIds.length) {
    return panic(
      `Corpus projection delete receipt matched ${rows.length} of ${intentIds.length} leased revisions`,
    );
  }
  return rows.length;
};

type VerifyCorpusProjectionCleanupSettlementsOptions = {
  client: Pick<CorpusIndexClient, "readDeleteSettlements" | "search">;
  indexId: string;
  /** Leases of `indexId`, all proved against one read of its split list. */
  leases: readonly CorpusProjectionCleanupSettlementLease[];
  /** Deterministic test clock for split maturity; defaults to now. */
  testNow?: Temporal.Instant;
};

export type CorpusProjectionCleanupSettlementLease = {
  family: CorpusFamily;
  generation: string;
  indexId: string;
  intentIds: readonly ProjectionIntentId[];
  deleteOpstamp: number;
  /** The metastore's creation instant for that delete task. */
  deleteTaskCreatedAt: Temporal.Instant;
  leaseToken: string;
};

/**
 * Delete tasks one settlement turn may lease.
 *
 * Cleanup issues one delete task per turn per index, so a turn that could
 * prove only one of them can never drain a backlog: settlement throughput has
 * to exceed the issue rate, not match it.
 */
const CORPUS_PROJECTION_SETTLEMENT_MAX_TASKS = 32;

type SettlementTaskGroup = {
  deleteOpstamp: number;
  deleteTaskCreatedAt: Temporal.Instant;
  intentIds: ProjectionIntentId[];
};

const validateSettlementTaskLimit = (taskLimit: number): number => {
  if (
    !Number.isSafeInteger(taskLimit) ||
    taskLimit < 1 ||
    taskLimit > CORPUS_PROJECTION_SETTLEMENT_MAX_TASKS
  ) {
    return panic(
      `Corpus projection settlement must lease 1 to ${CORPUS_PROJECTION_SETTLEMENT_MAX_TASKS} delete tasks per turn`,
    );
  }
  return taskLimit;
};

type ClaimCorpusProjectionCleanupSettlementOptions<
  Family extends CorpusFamily,
> = CorpusProjectionScopedWorkOptions<Family> & {
  generation: string;
  indexId: string;
  /** Revisions leased from one delete task. */
  limit: number;
  /** Delete tasks leased in this turn. */
  taskLimit: number;
  leaseMs: number;
  /** Deterministic database-test clock; production expiry uses PostgreSQL. */
  testNow?: Date;
  newLeaseToken?: () => string;
};

export const claimCorpusProjectionCleanupSettlementTx = async <
  Family extends CorpusFamily,
>(
  tx: Transaction,
  {
    family,
    generation,
    indexId,
    limit: requestedLimit,
    taskLimit: requestedTaskLimit,
    leaseMs: requestedLeaseMs,
    scope = CORPUS_PROJECTION_GENERATION_SCOPE,
    testNow,
    newLeaseToken = () => Bun.randomUUIDv7(),
  }: ClaimCorpusProjectionCleanupSettlementOptions<Family>,
): Promise<CorpusProjectionCleanupSettlementLease[]> => {
  const limit = validateCleanupBatchSize(requestedLimit);
  const taskLimit = validateSettlementTaskLimit(requestedTaskLimit);
  const leaseMs = validateLeaseMs(requestedLeaseMs);
  const scopedEntityIds = entityIdsForCorpusProjectionWorkScope(scope);
  await lockRegisteredCorpusProjectionManifestForMutation(
    tx,
    family,
    generation,
  );
  const settleable = and(
    eq(corpusIndexProjectionIntents.family, family),
    eq(corpusIndexProjectionIntents.generation, generation),
    eq(corpusIndexProjectionIntents.indexId, indexId),
    scopedEntityIds === null
      ? undefined
      : inArray(corpusIndexProjectionIntents.entityId, scopedEntityIds),
    eq(corpusIndexProjectionIntents.status, "cleanup_committed"),
    // A receipt written before the delete instant was persisted cannot be
    // proved against the splits that could hold its revisions. The online
    // repair behind the paired-receipt constraint fills those rows in, and
    // they become settleable again with no further transition.
    isNotNull(corpusIndexProjectionIntents.deleteTaskCreatedAt),
    or(
      isNull(corpusIndexProjectionIntents.leaseExpiresAt),
      sql`${corpusIndexProjectionIntents.leaseExpiresAt} <= clock_timestamp()`,
    ),
  );
  // Grouping cannot take row locks, so these identities are only a plan: the
  // rows behind them are re-read under lock below, and a task another turn
  // claimed in between simply yields no lease.
  const tasks = await tx
    .select({
      deleteOpstamp: corpusIndexProjectionIntents.deleteOpstamp,
      // One instant per task: the opstamp identifies the task inside this
      // index, and its receipt wrote both columns in one transition.
      deleteTaskCreatedAt: min(
        corpusIndexProjectionIntents.deleteTaskCreatedAt,
      ),
    })
    .from(corpusIndexProjectionIntents)
    .where(settleable)
    .groupBy(corpusIndexProjectionIntents.deleteOpstamp)
    .orderBy(
      asc(min(corpusIndexProjectionIntents.cleanupStartedAt)),
      asc(corpusIndexProjectionIntents.deleteOpstamp),
    )
    .limit(taskLimit);
  const taskInstants = new Map<string, Temporal.Instant>();
  const leasedOpstamps = tasks.map(({ deleteOpstamp, deleteTaskCreatedAt }) => {
    if (deleteOpstamp === null || deleteTaskCreatedAt === null) {
      return panic("Committed corpus projection cleanup has no delete receipt");
    }
    taskInstants.set(
      deleteOpstamp.toString(),
      Temporal.Instant.fromEpochMilliseconds(deleteTaskCreatedAt.getTime()),
    );
    return deleteOpstamp;
  });
  if (leasedOpstamps.length === 0) {
    return [];
  }
  const leasedTasks = inArray(
    corpusIndexProjectionIntents.deleteOpstamp,
    leasedOpstamps,
  );
  // Rank inside each delete task so one long task cannot spend the whole
  // turn's row budget. The ranking cannot lock (a window function and a
  // locking clause are exclusive), so the outer statement locks the intent
  // rows the ranking picked.
  const rankedRevisions = tx.$with("ranked_revisions").as(
    tx
      .select({
        id: corpusIndexProjectionIntents.id,
        taskRank: sql<number>`row_number() OVER (
          PARTITION BY ${corpusIndexProjectionIntents.deleteOpstamp}
          ORDER BY ${corpusIndexProjectionIntents.createdAt}, ${corpusIndexProjectionIntents.id}
        )`.as("task_rank"),
      })
      .from(corpusIndexProjectionIntents)
      .where(and(settleable, leasedTasks)),
  );
  const candidates = await tx
    .with(rankedRevisions)
    .select({
      id: corpusIndexProjectionIntents.id,
      deleteOpstamp: corpusIndexProjectionIntents.deleteOpstamp,
    })
    .from(corpusIndexProjectionIntents)
    .innerJoin(
      rankedRevisions,
      and(
        eq(rankedRevisions.id, corpusIndexProjectionIntents.id),
        lte(rankedRevisions.taskRank, limit),
      ),
    )
    // Total: two revisions committed by the same cleanup turn share both
    // timestamps, and the lease order follows this one.
    .orderBy(
      asc(corpusIndexProjectionIntents.cleanupStartedAt),
      asc(corpusIndexProjectionIntents.createdAt),
      asc(corpusIndexProjectionIntents.id),
    )
    .limit(limit * leasedOpstamps.length)
    .for("update", {
      of: corpusIndexProjectionIntents,
      skipLocked: true,
    });
  if (candidates.length === 0) {
    return [];
  }
  const leaseToken = newLeaseToken();
  const claimAt = testNow ?? sql<Date>`clock_timestamp()`;
  const leaseExpiresAt =
    testNow === undefined
      ? sql<Date>`clock_timestamp() + ${leaseMs} * INTERVAL '1 millisecond'`
      : new Date(testNow.getTime() + leaseMs);
  const candidateIds = candidates.map(({ id }) => id);
  const claimed = await tx
    .update(corpusIndexProjectionIntents)
    .set({ leaseToken, leaseExpiresAt, updatedAt: claimAt })
    .where(
      and(
        inArray(corpusIndexProjectionIntents.id, candidateIds),
        eq(corpusIndexProjectionIntents.status, "cleanup_committed"),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  if (claimed.length !== candidates.length) {
    return panic(
      `Corpus projection settlement claimed ${claimed.length} of ${candidates.length} revisions`,
    );
  }
  // One token for the turn: each lease settles or releases its own revisions,
  // and the identity sets behind two delete tasks are disjoint.
  const grouped = new Map<string, SettlementTaskGroup>();
  for (const { id, deleteOpstamp } of candidates) {
    if (deleteOpstamp === null) {
      return panic("Committed corpus projection cleanup has no delete receipt");
    }
    const numericOpstamp = Number(deleteOpstamp);
    if (!Number.isSafeInteger(numericOpstamp) || numericOpstamp < 0) {
      return panic(
        "Corpus projection delete opstamp exceeds safe integer range",
      );
    }
    const group = grouped.get(numericOpstamp.toString());
    if (group === undefined) {
      const deleteTaskCreatedAt = taskInstants.get(deleteOpstamp.toString());
      if (deleteTaskCreatedAt === undefined) {
        return panic("Leased corpus projection delete task lost its instant");
      }
      grouped.set(numericOpstamp.toString(), {
        deleteOpstamp: numericOpstamp,
        deleteTaskCreatedAt,
        intentIds: [id],
      });
      continue;
    }
    group.intentIds.push(id);
  }
  return [...grouped.values()].map(
    ({ deleteOpstamp, deleteTaskCreatedAt, intentIds }) => ({
      family,
      generation,
      indexId,
      intentIds,
      deleteOpstamp,
      deleteTaskCreatedAt,
      leaseToken,
    }),
  );
};

type SurvivorPending = Extract<
  CorpusProjectionCleanupPending,
  { reason: "survivor" }
>;

/**
 * Every pending reason but `survivor` is a wait: release the lease and prove
 * again on a later turn. A survivor carries the authority to issue the
 * delete again, which only `reissueCorpusProjectionCleanupTx` accepts.
 */
export type CorpusProjectionCleanupSettlementResult =
  | ({ status: "pending" } & Exclude<
      CorpusProjectionCleanupPending,
      SurvivorPending
    >)
  | ({
      status: "pending";
      reissue: CorpusProjectionCleanupReissue;
    } & SurvivorPending)
  | {
      status: "verified";
      proof: CorpusProjectionCleanupSettlementProof;
    };

type CorpusProjectionCleanupSettlementVerdict = {
  lease: CorpusProjectionCleanupSettlementLease;
  result: Result<CorpusProjectionCleanupSettlementResult, CorpusIndexError>;
};

type ProveCorpusProjectionCleanupSettlementOptions = {
  client: Pick<CorpusIndexClient, "search">;
  lease: CorpusProjectionCleanupSettlementLease;
  settlement: CorpusIndexDeleteSettlementRead;
  now: Temporal.Instant;
};

/**
 * The age floor for a survivor-shaped verdict. Merges can restart split
 * maturity beyond this instant, so the judgement must also check delete
 * progress over both proving and excluded splits before confirming a survivor.
 */
const survivorConfirmableAt = ({
  family,
  generation,
  deleteTaskCreatedAt,
}: CorpusProjectionCleanupSettlementLease): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(
    deleteTaskCreatedAt.epochMilliseconds +
      corpusIndexMaturationPeriodMs(
        requireCorpusIndexManifest(family, generation).engine.indexConfig
          .indexing_settings.merge_policy.maturation_period,
      ),
  );

/** Not exported, so no other module can construct reissue evidence. */
const REISSUE_CONSTRUCTION: unique symbol = Symbol(
  "corpus projection cleanup reissue",
);

/**
 * Opaque evidence that every split the listing holds crossed the delete
 * opstamp and that an exact revision query still found documents of the
 * leased revisions: they were written after the delete, so only a new one can
 * remove them.
 */
export class CorpusProjectionCleanupReissue {
  readonly indexId: string;
  readonly intentIds: readonly ProjectionIntentId[];
  readonly deleteOpstamp: number;
  readonly leaseToken: string;
  readonly remainingRevisionCount: number;

  /** Callable only in this module: settlement proof constructs it. */
  constructor(
    construction: typeof REISSUE_CONSTRUCTION,
    lease: CorpusProjectionCleanupSettlementLease,
    { remainingRevisionCount }: SurvivorPending,
  ) {
    if (construction !== REISSUE_CONSTRUCTION) {
      panic("Corpus projection reissue evidence has a foreign constructor");
    }
    this.indexId = lease.indexId;
    this.intentIds = [...lease.intentIds];
    this.deleteOpstamp = lease.deleteOpstamp;
    this.leaseToken = lease.leaseToken;
    this.remainingRevisionCount = remainingRevisionCount;
  }
}

/**
 * Opaque evidence that every split that could hold the deleted revisions
 * crossed the delete opstamp and that an exact revision query observed zero
 * remaining documents.
 */
export class CorpusProjectionCleanupSettlementProof {
  readonly indexId: string;
  readonly intentIds: readonly ProjectionIntentId[];
  readonly deleteOpstamp: number;
  readonly leaseToken: string;

  private constructor(
    indexId: string,
    intentIds: readonly ProjectionIntentId[],
    deleteOpstamp: number,
    leaseToken: string,
  ) {
    this.indexId = indexId;
    this.intentIds = intentIds;
    this.deleteOpstamp = deleteOpstamp;
    this.leaseToken = leaseToken;
  }

  /**
   * One verdict per lease, in lease order. The leases share one read of the
   * index's split list, so a turn's listing cost does not grow with the
   * number of delete tasks it proves; a failed read fails every lease.
   */
  static async verifyAll({
    client,
    indexId,
    leases,
    testNow,
  }: VerifyCorpusProjectionCleanupSettlementsOptions): Promise<
    CorpusProjectionCleanupSettlementVerdict[]
  > {
    for (const lease of leases) {
      if (
        lease.indexId !== indexId ||
        lease.intentIds.length === 0 ||
        lease.intentIds.length > CORPUS_PROJECTION_DELETE_MAX_REVISIONS ||
        !Number.isSafeInteger(lease.deleteOpstamp) ||
        lease.deleteOpstamp < 0
      ) {
        return panic("Corpus projection settlement request is invalid");
      }
    }
    // Which splits the delete has to have reached, and why the rest are not
    // evidence of anything. The cleanup fence issues a delete only after the
    // append publish barrier, so every revision this task targets was already
    // published when the metastore created the task; a document lives in
    // exactly one split. A split first published after that instant therefore
    // holds no targeted revision of its own, and the appends that keep
    // arriving cannot hold the proof open. A split with no publish timestamp
    // stays in the proof: the barrier schedules publication, it does not
    // prove it. What the split scan cannot see is a merge output published
    // after the task that inherited documents from an input published before
    // it; the exact revision count below is what refuses to settle then, and
    // it is the step that makes the proof exact rather than merely bounded.
    // A merge output carries the lowest opstamp of its inputs, so the listing
    // still shows it below the task, and a count it answers waits for the
    // engine instead of declaring a survivor.
    const settlements = await client.readDeleteSettlements({
      observer: "unobserved",
      indexId,
      tasks: leases.map(({ deleteOpstamp, deleteTaskCreatedAt }) => ({
        requiredOpstamp: deleteOpstamp,
        deleteCreatedAt: deleteTaskCreatedAt,
      })),
    });
    if (settlements.isErr()) {
      return leases.map((lease) => ({
        lease,
        result: Result.err(settlements.error),
      }));
    }
    if (settlements.value.length !== leases.length) {
      return panic(
        `Corpus index returned ${settlements.value.length} settlements for ${leases.length} delete tasks`,
      );
    }
    const now = testNow ?? Temporal.Now.instant();
    const verdicts: CorpusProjectionCleanupSettlementVerdict[] = [];
    for (const [index, lease] of leases.entries()) {
      const settlement =
        settlements.value.at(index) ??
        panic("Corpus projection settlement lost its delete task");
      verdicts.push({
        lease,
        result: await CorpusProjectionCleanupSettlementProof.prove({
          client,
          lease,
          settlement,
          now,
        }),
      });
    }
    return verdicts;
  }

  private static async prove({
    client,
    lease,
    settlement,
    now,
  }: ProveCorpusProjectionCleanupSettlementOptions): Promise<
    Result<CorpusProjectionCleanupSettlementResult, CorpusIndexError>
  > {
    if (settlement.isErr()) {
      return Result.err(settlement.error);
    }
    const listed = judgeCorpusProjectionCleanupSettlement({
      settlement: settlement.value,
      remainingRevisionCount: null,
      now,
      survivorConfirmableAt: survivorConfirmableAt(lease),
    });
    if (listed.type !== "count_required") {
      return Result.ok(
        CorpusProjectionCleanupSettlementProof.resultOf(lease, listed),
      );
    }
    const remaining = await countCorpusProjectionRevisions({
      client,
      indexId: lease.indexId,
      revisions: lease.intentIds,
    });
    if (remaining.isErr()) {
      return Result.err(remaining.error);
    }
    const counted = judgeCorpusProjectionCleanupSettlement({
      settlement: settlement.value,
      remainingRevisionCount: remaining.value,
      now,
      survivorConfirmableAt: survivorConfirmableAt(lease),
    });
    if (counted.type === "count_required") {
      return panic("Corpus projection settlement was counted twice");
    }
    return Result.ok(
      CorpusProjectionCleanupSettlementProof.resultOf(lease, counted),
    );
  }

  private static resultOf(
    lease: CorpusProjectionCleanupSettlementLease,
    judgement: Exclude<
      CorpusProjectionCleanupJudgement,
      { type: "count_required" }
    >,
  ): CorpusProjectionCleanupSettlementResult {
    switch (judgement.type) {
      case "verified":
        return {
          status: "verified",
          proof: new CorpusProjectionCleanupSettlementProof(
            lease.indexId,
            [...lease.intentIds],
            lease.deleteOpstamp,
            lease.leaseToken,
          ),
        };
      case "pending":
        return CorpusProjectionCleanupSettlementProof.pendingOf(
          lease,
          judgement.pending,
        );
      default: {
        judgement satisfies never;
        return panic(
          `Unhandled corpus projection settlement judgement ${String(judgement)}`,
        );
      }
    }
  }

  private static pendingOf(
    lease: CorpusProjectionCleanupSettlementLease,
    pending: CorpusProjectionCleanupPending,
  ): CorpusProjectionCleanupSettlementResult {
    switch (pending.reason) {
      case "staged_split":
      case "immature_split":
      case "delete_lagging":
      case "survivor_unconfirmed":
        return { status: "pending", ...pending };
      case "survivor":
        return {
          status: "pending",
          ...pending,
          reissue: new CorpusProjectionCleanupReissue(
            REISSUE_CONSTRUCTION,
            lease,
            pending,
          ),
        };
      default: {
        pending satisfies never;
        return panic(
          `Unhandled corpus projection pending reason ${String(pending)}`,
        );
      }
    }
  }
}

type ReleaseCorpusProjectionCleanupSettlementOptions = {
  lease: CorpusProjectionCleanupSettlementLease;
  testNow?: Date;
};

export const releaseCorpusProjectionCleanupSettlementTx = async (
  tx: Transaction,
  { lease, testNow }: ReleaseCorpusProjectionCleanupSettlementOptions,
): Promise<number> => {
  await lockCorpusIndexProjectionIntentMutationsTx(tx, lease.intentIds);
  await lockCorpusProjectionIntentsById(tx, lease.intentIds);
  const transitionAt = testNow ?? sql<Date>`clock_timestamp()`;
  const rows = await tx
    .update(corpusIndexProjectionIntents)
    .set({ leaseToken: null, leaseExpiresAt: null, updatedAt: transitionAt })
    .where(
      and(
        inArray(corpusIndexProjectionIntents.id, lease.intentIds),
        eq(corpusIndexProjectionIntents.indexId, lease.indexId),
        eq(corpusIndexProjectionIntents.status, "cleanup_committed"),
        eq(
          corpusIndexProjectionIntents.deleteOpstamp,
          BigInt(lease.deleteOpstamp),
        ),
        eq(corpusIndexProjectionIntents.leaseToken, lease.leaseToken),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  if (rows.length === lease.intentIds.length) {
    return rows.length;
  }
  // The settlement claim re-leases a revision whose lease has expired, and it
  // overwrites the token without matching the old one. A turn whose proof
  // outran its own lease therefore finds a successor owning the revisions it
  // came to relinquish, which the claim path is written to produce. Where that
  // successor has got to is not this turn's business: it may still hold the
  // lease, or have released or settled it already, and every one of those
  // clears this token. So the invariant is only that this lease is gone, not
  // which state replaced it — enumerating the successor's states would make an
  // ordinary finishing order panic.
  const released = new Set(rows.map(({ id }) => id));
  const unreleased = lease.intentIds.filter((id) => !released.has(id));
  const stillLeasedHere = await tx
    .select({ id: corpusIndexProjectionIntents.id })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        inArray(corpusIndexProjectionIntents.id, unreleased),
        eq(corpusIndexProjectionIntents.leaseToken, lease.leaseToken),
      ),
    );
  // Carrying this token while failing the release predicate means the row left
  // the index, status or delete task the lease was granted against without the
  // lease ever being given up, which no transition writes.
  if (stillLeasedHere.length > 0) {
    return panic(
      `Corpus projection settlement release matched ${rows.length} of ${lease.intentIds.length} leased revisions, and ${stillLeasedHere.length} of the rest still carry this lease`,
    );
  }
  return rows.length;
};

type SettleCorpusProjectionCleanupOptions = {
  proof: CorpusProjectionCleanupSettlementProof;
  testNow?: Date;
};

export const settleCorpusProjectionCleanupTx = async (
  tx: Transaction,
  { proof, testNow }: SettleCorpusProjectionCleanupOptions,
): Promise<number> => {
  await lockCorpusIndexProjectionIntentMutationsTx(tx, proof.intentIds);
  await lockCorpusProjectionStatesOfRevisions(tx, proof.intentIds);
  await lockCorpusProjectionIntentsById(tx, proof.intentIds);
  const transitionAt = testNow ?? sql<Date>`clock_timestamp()`;
  const rows = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "settled",
      leaseToken: null,
      leaseExpiresAt: null,
      settledAt: transitionAt,
      updatedAt: transitionAt,
    })
    .where(
      and(
        inArray(corpusIndexProjectionIntents.id, proof.intentIds),
        eq(corpusIndexProjectionIntents.indexId, proof.indexId),
        eq(corpusIndexProjectionIntents.status, "cleanup_committed"),
        eq(
          corpusIndexProjectionIntents.deleteOpstamp,
          BigInt(proof.deleteOpstamp),
        ),
        eq(corpusIndexProjectionIntents.leaseToken, proof.leaseToken),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  if (rows.length !== proof.intentIds.length) {
    return panic(
      `Corpus projection settlement matched ${rows.length} of ${proof.intentIds.length} verified revisions`,
    );
  }
  await wakeStatesAwaitingSettlementTx(tx, {
    intentIds: proof.intentIds,
    transitionAt,
  });
  return rows.length;
};

type WakeStatesAwaitingSettlementOptions = {
  intentIds: readonly ProjectionIntentId[];
  transitionAt: Date | SQL<Date>;
};

/**
 * A state that stopped naming its copy is queued for the append walk at the
 * instant that copy can have settled
 * (`corpusProjectionRetiredRevisionRunnableAt`). Once its entity has no
 * outstanding revision left, it is runnable now. A failure backoff
 * (`retry_not_before`) is left alone.
 */
const wakeStatesAwaitingSettlementTx = async (
  tx: Transaction,
  { intentIds, transitionAt }: WakeStatesAwaitingSettlementOptions,
): Promise<void> => {
  const settledEntities = tx
    .select({
      family: corpusIndexProjectionIntents.family,
      generation: corpusIndexProjectionIntents.generation,
      entityId: corpusIndexProjectionIntents.entityId,
    })
    .from(corpusIndexProjectionIntents)
    .where(inArray(corpusIndexProjectionIntents.id, [...intentIds]));
  // audit: skip - scheduling bookkeeping on the derived public corpus projection
  await tx
    .update(corpusIndexProjectionStates)
    .set({ updatedAt: transitionAt })
    .where(
      and(
        sql`(${corpusIndexProjectionStates.family}, ${corpusIndexProjectionStates.generation}, ${corpusIndexProjectionStates.entityId}) IN (${settledEntities})`,
        isNull(corpusIndexProjectionStates.appliedRevision),
        isNull(corpusIndexProjectionStates.retryNotBefore),
        // Queued for a later instant than the clock reads: only the
        // settlement bound sets one.
        sql`${corpusIndexProjectionStates.updatedAt} > clock_timestamp()`,
        sql`NOT EXISTS (
          SELECT 1
          FROM ${corpusIndexProjectionIntents} outstanding
          WHERE outstanding.family = ${corpusIndexProjectionStates.family}
            AND outstanding.generation = ${corpusIndexProjectionStates.generation}
            AND outstanding.entity_id = ${corpusIndexProjectionStates.entityId}
            AND ${corpusIndexProjectionIntentIsOutstanding(sql`outstanding.status`)}
        )`,
      ),
    );
};

/**
 * Deletes one revision may have issued again before it stalls. A revision
 * written after its delete needs one more; needing it again and again means
 * something keeps writing it, which another delete does not fix.
 */
export const CORPUS_PROJECTION_DELETE_REISSUE_LIMIT = 3;

type ReissueCorpusProjectionCleanupOptions = {
  reissue: CorpusProjectionCleanupReissue;
  testNow?: Date;
};

/** Per-revision outcome of one reissue, so a stall is never only a count. */
export type CorpusProjectionCleanupReissueResult = {
  /** Back in `cleanup_pending`: the next cleanup turn issues a new delete. */
  reissuedIntentIds: ProjectionIntentId[];
  /**
   * Now `cleanup_stalled`: their deletes were re-issued the limit already.
   * They keep their last receipt and block convergence until an operator
   * moves them back to cleanup.
   */
  stalledIntentIds: ProjectionIntentId[];
  /**
   * No longer held by this lease and left untouched: a successor took the
   * lease over after it expired, or a replay of this call moved them already.
   */
  unleasedIntentIds: ProjectionIntentId[];
};

/**
 * Sends revisions whose delete left survivors back to cleanup, or stalls the
 * ones that reached the reissue limit. Same lease discipline as release: only
 * rows still carrying this turn's lease move.
 */
export const reissueCorpusProjectionCleanupTx = async (
  tx: Transaction,
  { reissue, testNow }: ReissueCorpusProjectionCleanupOptions,
): Promise<CorpusProjectionCleanupReissueResult> => {
  await lockCorpusIndexProjectionIntentMutationsTx(tx, reissue.intentIds);
  await lockCorpusProjectionIntentsById(tx, reissue.intentIds);
  const transitionAt = testNow ?? sql<Date>`clock_timestamp()`;
  const heldByThisLease = and(
    inArray(corpusIndexProjectionIntents.id, reissue.intentIds),
    eq(corpusIndexProjectionIntents.indexId, reissue.indexId),
    eq(corpusIndexProjectionIntents.status, "cleanup_committed"),
    eq(
      corpusIndexProjectionIntents.deleteOpstamp,
      BigInt(reissue.deleteOpstamp),
    ),
    eq(corpusIndexProjectionIntents.leaseToken, reissue.leaseToken),
  );
  const survivorMessage = `corpus projection delete ${reissue.deleteOpstamp} left ${reissue.remainingRevisionCount} revision documents written after it`;
  const reissued = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cleanup_pending",
      leaseToken: null,
      leaseExpiresAt: null,
      cleanupNotBefore: transitionAt,
      cleanupStartedAt: null,
      deleteOpstamp: null,
      deleteTaskCreatedAt: null,
      deleteReissues: sql`${corpusIndexProjectionIntents.deleteReissues} + 1`,
      lastError: `${survivorMessage}; delete re-issued`,
      updatedAt: transitionAt,
    })
    .where(
      and(
        heldByThisLease,
        lt(
          corpusIndexProjectionIntents.deleteReissues,
          CORPUS_PROJECTION_DELETE_REISSUE_LIMIT,
        ),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  const stalled = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cleanup_stalled",
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: `${survivorMessage} after ${CORPUS_PROJECTION_DELETE_REISSUE_LIMIT} re-issued deletes; cleanup stalled`,
      updatedAt: transitionAt,
    })
    .where(
      and(
        heldByThisLease,
        gte(
          corpusIndexProjectionIntents.deleteReissues,
          CORPUS_PROJECTION_DELETE_REISSUE_LIMIT,
        ),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  // In lease order, whatever order the updates returned their rows in.
  const reissuedIds = new Set(reissued.map(({ id }) => id));
  const stalledIds = new Set(stalled.map(({ id }) => id));
  const reissuedIntentIds = reissue.intentIds.filter((id) =>
    reissuedIds.has(id),
  );
  const stalledIntentIds = reissue.intentIds.filter((id) => stalledIds.has(id));
  const unleasedIntentIds = reissue.intentIds.filter(
    (id) => !reissuedIds.has(id) && !stalledIds.has(id),
  );
  if (unleasedIntentIds.length > 0) {
    // As in release: a row that still carries this token but failed the
    // predicate left the index, status or delete task its lease was granted
    // against without giving the lease up, which no transition writes.
    const stillLeasedHere = await tx
      .select({ id: corpusIndexProjectionIntents.id })
      .from(corpusIndexProjectionIntents)
      .where(
        and(
          inArray(corpusIndexProjectionIntents.id, unleasedIntentIds),
          eq(corpusIndexProjectionIntents.leaseToken, reissue.leaseToken),
        ),
      );
    if (stillLeasedHere.length > 0) {
      return panic(
        `Corpus projection reissue left ${stillLeasedHere.length} of ${reissue.intentIds.length} leased revisions on this lease`,
      );
    }
  }
  if (stalledIntentIds.length > 0) {
    logger.warn("corpus_projection.cleanup_stalled", {
      index: reissue.indexId,
      opstamp: reissue.deleteOpstamp,
      remaining: reissue.remainingRevisionCount,
      revisions: stalledIntentIds.length,
    });
  }
  return { reissuedIntentIds, stalledIntentIds, unleasedIntentIds };
};

type ReopenCorpusProjectionCleanupOptions = {
  intentIds: readonly ProjectionIntentId[];
  indexId: string;
  errorMessage: string;
  testNow?: Date;
};

/**
 * Reopen exact settled or withdrawn revisions when a later census observes
 * them: a withdrawal is disproved the way a settlement is, and its revision
 * takes the same exact cleanup.
 */
export const reopenCorpusProjectionCleanupTx = async (
  tx: Transaction,
  {
    intentIds,
    indexId,
    errorMessage,
    testNow,
  }: ReopenCorpusProjectionCleanupOptions,
): Promise<number> => {
  if (
    intentIds.length === 0 ||
    intentIds.length > CORPUS_PROJECTION_DELETE_MAX_REVISIONS
  ) {
    return panic("Corpus projection cleanup reopen request is invalid");
  }
  await lockCorpusIndexProjectionIntentMutationsTx(tx, intentIds);
  const identities = await tx
    .select({
      family: corpusIndexProjectionIntents.family,
      generation: corpusIndexProjectionIntents.generation,
      entityId: corpusIndexProjectionIntents.entityId,
    })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        inArray(corpusIndexProjectionIntents.id, intentIds),
        eq(corpusIndexProjectionIntents.indexId, indexId),
        inArray(
          corpusIndexProjectionIntents.status,
          CORPUS_PROJECTION_REOPENABLE_STATUSES,
        ),
      ),
    );
  if (identities.length !== intentIds.length) {
    return panic("Corpus projection cleanup reopen identities changed");
  }
  const statePredicate = or(
    ...identities.map(({ family, generation, entityId }) =>
      and(
        eq(corpusIndexProjectionStates.family, family),
        eq(corpusIndexProjectionStates.generation, generation),
        eq(corpusIndexProjectionStates.entityId, entityId),
      ),
    ),
  );
  if (statePredicate === undefined) {
    return panic("Corpus projection cleanup reopen state predicate is empty");
  }
  await tx
    .select({ entityId: corpusIndexProjectionStates.entityId })
    .from(corpusIndexProjectionStates)
    .where(statePredicate)
    .orderBy(
      asc(corpusIndexProjectionStates.family),
      asc(corpusIndexProjectionStates.generation),
      asc(corpusIndexProjectionStates.entityId),
    )
    .limit(identities.length)
    .for("update");
  await lockCorpusProjectionIntentsById(tx, intentIds);
  const transitionAt = testNow ?? sql<Date>`clock_timestamp()`;
  const reopenedIdsSql = sql.join(
    intentIds.map((intentId) => sql`${intentId}`),
    sql.raw(", "),
  );
  await tx
    .update(corpusIndexProjectionStates)
    .set({
      appliedAction: null,
      appliedEpoch: null,
      appliedRevision: null,
      appliedFingerprint: null,
      appliedIndexId: null,
      appliedAt: null,
      updatedAt: transitionAt,
    })
    .where(
      and(
        statePredicate,
        eq(corpusIndexProjectionStates.appliedAction, "erase"),
        sql`EXISTS (
          SELECT 1
          FROM ${corpusIndexProjectionIntents} reopened
          WHERE reopened.id IN (${reopenedIdsSql})
            AND reopened.family = ${corpusIndexProjectionStates.family}
            AND reopened.generation = ${corpusIndexProjectionStates.generation}
            AND reopened.entity_id = ${corpusIndexProjectionStates.entityId}
            AND reopened.epoch <= ${corpusIndexProjectionStates.appliedEpoch}
            AND ${inArray(sql`reopened.status`, CORPUS_PROJECTION_REOPEN_FROM_STATUSES)}
        )`,
      ),
    );
  const rows = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cleanup_pending",
      leaseToken: null,
      leaseExpiresAt: null,
      cleanupNotBefore: transitionAt,
      cleanupStartedAt: null,
      deleteOpstamp: null,
      deleteTaskCreatedAt: null,
      settledAt: null,
      lastError: errorMessage.slice(0, 2048),
      updatedAt: transitionAt,
    })
    .where(
      and(
        inArray(corpusIndexProjectionIntents.id, intentIds),
        eq(corpusIndexProjectionIntents.indexId, indexId),
        inArray(
          corpusIndexProjectionIntents.status,
          CORPUS_PROJECTION_REOPEN_FROM_STATUSES,
        ),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  const converged = await tx
    .select({
      id: corpusIndexProjectionIntents.id,
      status: corpusIndexProjectionIntents.status,
    })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        inArray(corpusIndexProjectionIntents.id, intentIds),
        eq(corpusIndexProjectionIntents.indexId, indexId),
      ),
    )
    .limit(intentIds.length);
  if (
    converged.length !== intentIds.length ||
    converged.some(
      ({ status }) =>
        !CORPUS_PROJECTION_REOPEN_CONVERGED_STATUS_SET.has(status),
    )
  ) {
    return panic("Corpus projection cleanup reopen identities changed");
  }
  return rows.length;
};

export type CorpusProjectionExpiredIntent = {
  intentId: ProjectionIntentId;
  status: Extract<
    CorpusIndexIntentStatus,
    "reserved" | "append_started" | "cleanup_started"
  >;
};

const recoveredIntent = ({
  id,
  status,
}: Pick<
  typeof corpusIndexProjectionIntents.$inferSelect,
  "id" | "status"
>): CorpusProjectionExpiredIntent => {
  if (
    status !== "reserved" &&
    status !== "append_started" &&
    status !== "cleanup_started"
  ) {
    return panic(`Unexpected expired projection intent status: ${status}`);
  }
  return { intentId: id, status };
};

type RecoverExpiredCorpusProjectionIntentsOptions<Family extends CorpusFamily> =
  CorpusProjectionScopedWorkOptions<Family> & {
    generation: string;
    limit: number;
    testNow?: Date;
  };

type ExpiredAppendStateTarget = Pick<
  typeof corpusIndexProjectionIntents.$inferSelect,
  "entityId" | "epoch" | "fingerprint" | "indexId"
>;

type ChargeExpiredAppendStatesOptions = {
  family: CorpusFamily;
  generation: string;
  targets: readonly ExpiredAppendStateTarget[];
  transitionAt: Date | SQL<Date>;
};

const expiredAppendTargets = (targets: readonly ExpiredAppendStateTarget[]) =>
  or(
    ...targets.map((row) =>
      and(
        eq(corpusIndexProjectionStates.entityId, row.entityId),
        eq(corpusIndexProjectionStates.desiredEpoch, row.epoch),
        eq(corpusIndexProjectionStates.desiredFingerprint, row.fingerprint),
        eq(corpusIndexProjectionStates.desiredIndexId, row.indexId),
      ),
    ),
  );

const chargeExpiredAppendStatesTx = async (
  tx: Transaction,
  {
    family,
    generation,
    targets,
    transitionAt,
  }: ChargeExpiredAppendStatesOptions,
): Promise<void> => {
  const nextAttempts = sql<number>`${corpusIndexProjectionStates.failureAttempts} + 1`;
  const exhausted = sql<boolean>`${nextAttempts} >= ${CORPUS_PROJECTION_APPEND_UNKNOWN_ATTEMPT_LIMIT}`;
  const retryDelayMs = sql<number>`LEAST(
    ${CORPUS_PROJECTION_APPEND_RETRY_CAP_MS},
    ${CORPUS_PROJECTION_APPEND_RETRY_BASE_MS} * POWER(
      2,
      LEAST(${corpusIndexProjectionStates.failureAttempts}, 6)
    )
  )`;
  const updated = await tx
    .update(corpusIndexProjectionStates)
    .set({
      workStatus: sql<"blocked" | "retry_scheduled">`CASE
        WHEN ${exhausted} THEN 'blocked'
        ELSE 'retry_scheduled'
      END`,
      retryNotBefore: sql<Date | null>`CASE
        WHEN ${exhausted} THEN NULL::timestamptz
        ELSE ${transitionAt}::timestamptz + ${retryDelayMs} * INTERVAL '1 millisecond'
      END`,
      failureAttempts: nextAttempts,
      lastFailureKind: "append_unknown",
      lastFailureMessage:
        "projection append lease expired with unknown outcome",
      updatedAt: transitionAt,
    })
    .where(
      and(
        eq(corpusIndexProjectionStates.family, family),
        eq(corpusIndexProjectionStates.generation, generation),
        eq(corpusIndexProjectionStates.desiredAction, "upsert"),
        expiredAppendTargets(targets),
      ),
    )
    .returning({
      entityId: corpusIndexProjectionStates.entityId,
      failureAttempts: corpusIndexProjectionStates.failureAttempts,
      workStatus: corpusIndexProjectionStates.workStatus,
    });
  for (const row of updated) {
    if (row.workStatus === "blocked") {
      logger.warn("corpus_projection.append_blocked", {
        family,
        generation,
        entity: row.entityId,
        kind: "append_unknown",
        attempts: row.failureAttempts,
      });
    }
  }
};

const deferExpiredBatchStatesTx = async (
  tx: Transaction,
  {
    family,
    generation,
    targets,
    transitionAt,
  }: ChargeExpiredAppendStatesOptions,
): Promise<void> => {
  await tx
    .update(corpusIndexProjectionStates)
    .set({
      workStatus: "retry_scheduled",
      retryNotBefore: sql<Date>`${transitionAt}::timestamptz + ${CORPUS_PROJECTION_APPEND_RETRY_BASE_MS} * INTERVAL '1 millisecond'`,
      appendMode: "single",
      lastFailureKind: "append_unknown",
      lastFailureMessage:
        "projection batch append lease expired with unknown outcome",
      updatedAt: transitionAt,
    })
    .where(
      and(
        eq(corpusIndexProjectionStates.family, family),
        eq(corpusIndexProjectionStates.generation, generation),
        eq(corpusIndexProjectionStates.desiredAction, "upsert"),
        expiredAppendTargets(targets),
      ),
    );
};

const updateExpiredAppendStatesTx = async (
  tx: Transaction,
  {
    family,
    generation,
    targets,
    transitionAt,
  }: Omit<ChargeExpiredAppendStatesOptions, "targets"> & {
    targets: readonly (ExpiredAppendStateTarget & {
      appendRequestRevisionCount: number | null;
    })[];
  },
): Promise<void> => {
  const isolated = targets.filter(
    ({ appendRequestRevisionCount }) => appendRequestRevisionCount === 1,
  );
  const batches = targets.filter(
    ({ appendRequestRevisionCount }) => appendRequestRevisionCount !== 1,
  );
  if (isolated.length > 0) {
    await chargeExpiredAppendStatesTx(tx, {
      family,
      generation,
      targets: isolated,
      transitionAt,
    });
  }
  if (batches.length > 0) {
    await deferExpiredBatchStatesTx(tx, {
      family,
      generation,
      targets: batches,
      transitionAt,
    });
  }
};

type CommitExpiredOfflineAppendsOptions = {
  manifest: CorpusIndexManifest;
  /** Expired starts of any delivery; only offline ones are committed. */
  rows: readonly {
    id: ProjectionIntentId;
    appendStartedAt: Date | null;
  }[];
  transitionAt: Date | SQL<Date>;
};

/**
 * An expired offline start is not an unknown write. Its document count was
 * stored with the start and its indexer is killed by a deadline counted from
 * that start, so it is recorded as committed behind the instant the run has
 * certainly ended (`offline_unended`), and the prover's census decides it:
 * exact applies it, empty withdraws it, anything else retires it. Only a
 * revision its state still wants advances; any other goes to cleanup with the
 * unknown appends. The state is not charged here: the proof charges what it
 * retires or withdraws, and an applied revision costs nothing.
 */
const commitExpiredOfflineAppendsTx = async (
  tx: Transaction,
  { manifest, rows, transitionAt }: CommitExpiredOfflineAppendsOptions,
): Promise<Set<ProjectionIntentId>> => {
  // audit: skip - lease recovery bookkeeping on the derived public corpus projection
  if (rows.length === 0) {
    return new Set();
  }
  const barrierSql = sqlCaseFragment({
    operand: sql`${corpusIndexProjectionIntents.id}`,
    branches: rows.map(({ id, appendStartedAt }) => {
      const barrier = corpusProjectionAppendPublishBarrier(
        {
          type: "offline_unended",
          appendStartedAt:
            appendStartedAt ??
            panic(`Append-started projection intent has no start: ${id}`),
        },
        manifest,
      );
      return sql`WHEN ${id}::uuid THEN ${barrier}::timestamptz`;
    }),
    fallback: sql`${corpusIndexProjectionIntents.appendPublishBarrierAt}`,
  });
  const committed = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "append_committed",
      leaseToken: null,
      leaseExpiresAt: null,
      appendCommittedAt: transitionAt,
      appendPublishBarrierAt: barrierSql,
      // No `last_error`: a revision this census applies must stay restorable
      // like any other (`corpusIndexProjectionRevisionIsRestorable`).
      updatedAt: transitionAt,
    })
    .where(
      and(
        inArray(
          corpusIndexProjectionIntents.id,
          rows.map(({ id }) => id),
        ),
        eq(corpusIndexProjectionIntents.status, "append_started"),
        eq(corpusIndexProjectionIntents.appendDelivery, "offline_indexer"),
        isNotNull(corpusIndexProjectionIntents.expectedDocumentCount),
        sql`EXISTS (
          SELECT 1
          FROM ${corpusIndexProjectionStates} state
          WHERE state.family = ${corpusIndexProjectionIntents.family}
            AND state.generation = ${corpusIndexProjectionIntents.generation}
            AND state.entity_id = ${corpusIndexProjectionIntents.entityId}
            AND state.desired_action = 'upsert'
            AND state.desired_epoch = ${corpusIndexProjectionIntents.epoch}
            AND state.desired_fingerprint = ${corpusIndexProjectionIntents.fingerprint}
            AND state.desired_index_id = ${corpusIndexProjectionIntents.indexId}
        )`,
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  return new Set(committed.map(({ id }) => id));
};

/**
 * Recover expired intents by phase: cancel a reservation, treat an append as
 * an unknown write requiring cleanup unless its offline delivery lets a census
 * decide it (`commitExpiredOfflineAppendsTx`), and retry an expired delete
 * exactly.
 */
export const recoverExpiredCorpusProjectionIntentsTx = async <
  Family extends CorpusFamily,
>(
  tx: Transaction,
  {
    family,
    generation,
    limit: requestedLimit,
    scope = CORPUS_PROJECTION_GENERATION_SCOPE,
    testNow,
  }: RecoverExpiredCorpusProjectionIntentsOptions<Family>,
): Promise<CorpusProjectionExpiredIntent[]> => {
  const limit = validateCleanupBatchSize(requestedLimit);
  const scopedEntityIds = entityIdsForCorpusProjectionWorkScope(scope);
  await lockCorpusIndexProjectionMutationsTx(tx, [{ family, generation }]);
  const manifest = await lockRegisteredCorpusProjectionManifestForMutation(
    tx,
    family,
    generation,
  );
  const candidates = await tx
    .select({
      id: corpusIndexProjectionIntents.id,
      status: corpusIndexProjectionIntents.status,
      entityId: corpusIndexProjectionIntents.entityId,
    })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.family, family),
        eq(corpusIndexProjectionIntents.generation, generation),
        scopedEntityIds === null
          ? undefined
          : inArray(corpusIndexProjectionIntents.entityId, scopedEntityIds),
        inArray(corpusIndexProjectionIntents.status, [
          "reserved",
          "append_started",
          "cleanup_started",
        ]),
        sql`${corpusIndexProjectionIntents.leaseExpiresAt} <= clock_timestamp()`,
      ),
    )
    .orderBy(asc(corpusIndexProjectionIntents.leaseExpiresAt))
    .limit(limit);
  if (candidates.length === 0) {
    return [];
  }
  const appendEntityIds = candidates
    .filter(({ status }) => status === "append_started")
    .map(({ entityId }) => entityId);
  if (appendEntityIds.length > 0) {
    await tx
      .select({ entityId: corpusIndexProjectionStates.entityId })
      .from(corpusIndexProjectionStates)
      .where(
        and(
          eq(corpusIndexProjectionStates.family, family),
          eq(corpusIndexProjectionStates.generation, generation),
          inArray(corpusIndexProjectionStates.entityId, appendEntityIds),
        ),
      )
      .orderBy(asc(corpusIndexProjectionStates.entityId))
      .limit(appendEntityIds.length)
      .for("update");
  }
  const rows = await tx
    .select({
      id: corpusIndexProjectionIntents.id,
      status: corpusIndexProjectionIntents.status,
      entityId: corpusIndexProjectionIntents.entityId,
      epoch: corpusIndexProjectionIntents.epoch,
      fingerprint: corpusIndexProjectionIntents.fingerprint,
      indexId: corpusIndexProjectionIntents.indexId,
      appendStartedAt: corpusIndexProjectionIntents.appendStartedAt,
      appendRequestRevisionCount:
        corpusIndexProjectionIntents.appendRequestRevisionCount,
    })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        inArray(
          corpusIndexProjectionIntents.id,
          candidates.map(({ id }) => id),
        ),
        inArray(corpusIndexProjectionIntents.status, [
          "reserved",
          "append_started",
          "cleanup_started",
        ]),
        sql`${corpusIndexProjectionIntents.leaseExpiresAt} <= clock_timestamp()`,
      ),
    )
    .orderBy(asc(corpusIndexProjectionIntents.leaseExpiresAt))
    .limit(limit)
    .for("update", { skipLocked: true });

  const transitionAt = testNow ?? sql<Date>`clock_timestamp()`;

  const reserved = rows.filter(({ status }) => status === "reserved");
  if (reserved.length > 0) {
    await tx
      .update(corpusIndexProjectionIntents)
      .set({
        status: "cancelled",
        leaseToken: null,
        leaseExpiresAt: null,
        cancelledAt: transitionAt,
        lastError: CORPUS_INDEX_APPEND_CANCEL_REASON.leaseExpired,
        updatedAt: transitionAt,
      })
      .where(
        and(
          inArray(
            corpusIndexProjectionIntents.id,
            reserved.map(({ id }) => id),
          ),
          eq(corpusIndexProjectionIntents.status, "reserved"),
        ),
      );
  }

  const cleanupStarted = rows.filter(
    ({ status }) => status === "cleanup_started",
  );
  if (cleanupStarted.length > 0) {
    await tx
      .update(corpusIndexProjectionIntents)
      .set({
        status: "cleanup_pending",
        leaseToken: null,
        leaseExpiresAt: null,
        cleanupStartedAt: null,
        lastError: "projection cleanup lease expired with unknown outcome",
        updatedAt: transitionAt,
      })
      .where(
        and(
          inArray(
            corpusIndexProjectionIntents.id,
            cleanupStarted.map(({ id }) => id),
          ),
          eq(corpusIndexProjectionIntents.status, "cleanup_started"),
        ),
      );
  }

  const appendStarted = rows.filter(
    ({ status }) => status === "append_started",
  );
  const offlineCommitted = await commitExpiredOfflineAppendsTx(tx, {
    manifest,
    rows: appendStarted,
    transitionAt,
  });
  await retireExpiredUnknownAppendsTx(tx, {
    family,
    generation,
    manifest,
    rows: appendStarted.filter(({ id }) => !offlineCommitted.has(id)),
    transitionAt,
  });
  return rows.map(recoveredIntent);
};

type RetireExpiredUnknownAppendsOptions = {
  family: CorpusFamily;
  generation: string;
  manifest: CorpusIndexManifest;
  rows: readonly (ExpiredAppendStateTarget & {
    id: ProjectionIntentId;
    appendStartedAt: Date | null;
    appendRequestRevisionCount: number | null;
  })[];
  transitionAt: Date | SQL<Date>;
};

/**
 * An expired append whose outcome is unknown may have written anything up to
 * its request's end, so it goes to exact cleanup behind the barrier counted
 * from its start, and its entity is charged as the request decides.
 */
const retireExpiredUnknownAppendsTx = async (
  tx: Transaction,
  {
    family,
    generation,
    manifest,
    rows,
    transitionAt,
  }: RetireExpiredUnknownAppendsOptions,
): Promise<void> => {
  // audit: skip - lease recovery bookkeeping on the derived public corpus projection
  if (rows.length === 0) {
    return;
  }
  const barriers = rows.map((row) => {
    if (row.appendStartedAt === null) {
      return panic(`Append-started projection intent has no start: ${row.id}`);
    }
    return {
      id: row.id,
      barrier: corpusProjectionAppendPublishBarrier(
        { type: "unknown", appendStartedAt: row.appendStartedAt },
        manifest,
      ),
    };
  });
  const barrierSql = sqlCaseFragment({
    operand: sql`${corpusIndexProjectionIntents.id}`,
    branches: barriers.map(
      ({ id, barrier }) => sql`WHEN ${id} THEN ${barrier}::timestamptz`,
    ),
    fallback: sql`${corpusIndexProjectionIntents.appendPublishBarrierAt}`,
  });
  await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cleanup_pending",
      leaseToken: null,
      leaseExpiresAt: null,
      appendPublishBarrierAt: barrierSql,
      cleanupNotBefore: barrierSql,
      lastError: "projection append lease expired with unknown outcome",
      updatedAt: transitionAt,
    })
    .where(
      and(
        inArray(
          corpusIndexProjectionIntents.id,
          rows.map(({ id }) => id),
        ),
        eq(corpusIndexProjectionIntents.status, "append_started"),
      ),
    );
  await updateExpiredAppendStatesTx(tx, {
    family,
    generation,
    targets: rows,
    transitionAt,
  });
};
