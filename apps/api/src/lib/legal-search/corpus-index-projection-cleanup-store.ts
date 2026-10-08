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
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import type {
  CorpusIndexClient,
  CorpusIndexDeleteSettlementRead,
  CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import { corpusIndexMaturationPeriodMs } from "@/api/lib/legal-search/corpus-index-config";
import { requireCorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  CORPUS_INDEX_APPEND_CANCEL_REASON,
  type CorpusIndexIntentStatus,
} from "@/api/lib/legal-search/corpus-index-projection-contract";
import { lockRegisteredCorpusProjectionManifestForMutation } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
  corpusIndexUnknownAppendBarrierAt,
  countCorpusProjectionRevisions,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  lockCorpusIndexProjectionIntentMutationsTx,
  lockCorpusIndexProjectionMutationsTx,
} from "@/api/lib/legal-search/corpus-index-projection-revision";
import {
  CORPUS_PROJECTION_GENERATION_SCOPE,
  entityIdsForCorpusProjectionWorkScope,
  type CorpusProjectionScopedWorkOptions,
} from "@/api/lib/legal-search/corpus-index-projection-scope";
import {
  type CorpusProjectionCleanupJudgement,
  type CorpusProjectionCleanupPending,
  judgeCorpusProjectionCleanupSettlement,
} from "@/api/lib/legal-search/corpus-index-projection-settlement-judgement";
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
const CORPUS_PROJECTION_REOPENABLE_STATUSES = [
  ...CORPUS_PROJECTION_REOPEN_CONVERGED_STATUSES,
  "settled",
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

export type CorpusProjectionCleanupLease = {
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
): Promise<CorpusProjectionCleanupLease[]> => {
  const limit = validateCleanupBatchSize(requestedLimit);
  const leaseMs = validateLeaseMs(requestedLeaseMs);
  const scopedEntityIds = entityIdsForCorpusProjectionWorkScope(scope);
  await lockRegisteredCorpusProjectionManifestForMutation(
    tx,
    family,
    generation,
  );
  const candidates = await tx
    .select({
      id: corpusIndexProjectionIntents.id,
      entityId: corpusIndexProjectionIntents.entityId,
    })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.family, family),
        eq(corpusIndexProjectionIntents.generation, generation),
        eq(corpusIndexProjectionIntents.indexId, indexId),
        scopedEntityIds === null
          ? undefined
          : inArray(corpusIndexProjectionIntents.entityId, scopedEntityIds),
        eq(corpusIndexProjectionIntents.status, "cleanup_pending"),
        sql`${corpusIndexProjectionIntents.cleanupNotBefore} <= clock_timestamp()`,
        or(
          isNull(corpusIndexProjectionIntents.leaseExpiresAt),
          sql`${corpusIndexProjectionIntents.leaseExpiresAt} <= clock_timestamp()`,
        ),
      ),
    )
    .orderBy(
      asc(corpusIndexProjectionIntents.cleanupNotBefore),
      asc(corpusIndexProjectionIntents.createdAt),
    )
    .limit(limit)
    .for("update", { skipLocked: true });
  if (candidates.length === 0) {
    return [];
  }
  const claimAt = testNow ?? sql<Date>`clock_timestamp()`;
  const leaseToken = newLeaseToken();
  const leaseExpiresAt =
    testNow === undefined
      ? sql<Date>`clock_timestamp() + ${leaseMs} * INTERVAL '1 millisecond'`
      : new Date(testNow.getTime() + leaseMs);
  const ids = candidates.map(({ id }) => id);
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
        inArray(corpusIndexProjectionIntents.id, ids),
        eq(corpusIndexProjectionIntents.status, "cleanup_pending"),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  if (updated.length !== candidates.length) {
    return panic(
      `Corpus projection cleanup claimed ${updated.length} of ${candidates.length} revisions`,
    );
  }
  return candidates.map((candidate) => ({
    intentId: candidate.id,
    family,
    generation,
    entityId: candidate.entityId,
    indexId,
    leaseToken,
  }));
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
 * When a survivor-shaped verdict may stand: once every split that existed
 * when the delete task was created has had its maturation period, the engine
 * has applied the task wherever it can, and a split the listing missed can no
 * longer be one it is still to reach.
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
  return rows.length;
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

/** Reopen exact settled revisions when a later census observes them again. */
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
            AND reopened.status = 'settled'
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
        eq(corpusIndexProjectionIntents.status, "settled"),
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

/**
 * Recover expired intents by phase: cancel a reservation, treat an append as
 * an unknown write requiring cleanup, and retry an expired delete exactly.
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
  if (appendStarted.length > 0) {
    const barriers = appendStarted.map((row) => {
      if (row.appendStartedAt === null) {
        return panic(
          `Append-started projection intent has no start: ${row.id}`,
        );
      }
      return {
        id: row.id,
        barrier: corpusIndexUnknownAppendBarrierAt(
          row.appendStartedAt,
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
            appendStarted.map(({ id }) => id),
          ),
          eq(corpusIndexProjectionIntents.status, "append_started"),
        ),
      );
    await updateExpiredAppendStatesTx(tx, {
      family,
      generation,
      targets: appendStarted,
      transitionAt,
    });
  }
  return rows.map(recoveredIntent);
};
