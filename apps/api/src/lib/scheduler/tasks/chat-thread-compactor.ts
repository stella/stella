/**
 * Durable chat-thread compaction.
 *
 * A send that crosses its thread's compaction trigger stamps the thread due and
 * returns; this task drains that queue out of band. Compaction therefore never
 * runs inside a request, never depends on the sending process surviving, and
 * retries by itself: the queue row is the durable record, and an unsettled
 * lease returns the thread to the queue.
 *
 * Runs on the root connection because it spans every tenant. Each thread's work
 * is then done for its owner, under the owner's organization and matter
 * membership as it stands when the run executes, so nothing widens and a
 * thread whose owner has since lost access is not compacted.
 */
import { panic, Result, TaggedError, UnhandledException } from "better-result";
import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { resolveChatCompactionBudget } from "@/api/lib/chat/compaction-budget";
import {
  ChatCompactionError,
  runChatThreadCompaction,
} from "@/api/lib/chat/thread-compaction";
import type { ChatCompactionOutcome } from "@/api/lib/chat/thread-compaction";
import { executedRows } from "@/api/lib/db/executed-rows";
import { holdMemberAccessOnTx } from "@/api/lib/db/member-access-hold";
import { errorTag } from "@/api/lib/errors/utils";
import { runScheduledBackgroundWork } from "@/api/lib/rate-limit/queued-action-admission";
import {
  createRootMembershipSafeDb,
  createRootMembershipScopedDb,
} from "@/api/lib/root-scoped-db";
import type { MembershipSafeDb } from "@/api/lib/root-scoped-db";
import {
  buildClaimChatCompactionQueueQuery,
  buildSettleChatCompactionQueueQuery,
  CHAT_COMPACTION_QUEUE_LEASE_MS,
  CHAT_COMPACTION_SETTLEMENT,
  parseChatCompactionQueueRows,
} from "@/api/lib/scheduler/tasks/chat-thread-compactor-queue";
import type {
  ChatCompactionSettlement,
  QueuedCompactionThread,
} from "@/api/lib/scheduler/tasks/chat-thread-compactor-queue";
import type {
  SchedulerDb,
  SchedulerTask,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";

export const CHAT_THREAD_COMPACTOR_TASK = "chat.compactThreads" as const;

const COMPACTION_TIMEOUT_MS = 60_000;

/**
 * Why a claimed thread is not compacted for its owner.
 *
 *  - `owner-left-organization`: the owner is no longer a member of the
 *    thread's organization.
 *  - `thread-out-of-scope`: the owner's current membership no longer reads the
 *    thread. Thread RLS requires every matter in `data_workspace_ids` (and the
 *    thread's own matter) to stay accessible, because the messages embed
 *    content from all of them, so losing any one hides the whole thread.
 */
export const OWNER_ACCESS_LOST_REASON = {
  ORGANIZATION: "owner-left-organization",
  THREAD: "thread-out-of-scope",
} as const;
type OwnerAccessLostReason =
  (typeof OWNER_ACCESS_LOST_REASON)[keyof typeof OWNER_ACCESS_LOST_REASON];

export type ChatCompactorOutcome =
  | ChatCompactionOutcome
  | { type: "owner-access-lost"; reason: OwnerAccessLostReason };

type ChatThreadCompactorOptions = {
  /** The RLS connection the owner's reads and writes run on. Tests inject
   *  their database; production uses the application connection. */
  database?: RlsDatabase<Transaction>;
};

export const createChatThreadCompactor =
  ({ database }: ChatThreadCompactorOptions = {}): SchedulerTask =>
  async (context) =>
    await drainCompactionQueue({ ...context, database });

export const compactChatThreads = createChatThreadCompactor();

type DrainCompactionQueueOptions = Pick<
  SchedulerTaskContext,
  "db" | "logger" | "signal"
> & { database: RlsDatabase<Transaction> | undefined };

const drainCompactionQueue = async ({
  database,
  db,
  logger,
  signal,
}: DrainCompactionQueueOptions): Promise<void> => {
  const claim = await claimCompactionBatch(db);

  let advanced = 0;
  let upToDate = 0;
  let superseded = 0;
  let noSummary = 0;
  let anonymized = 0;
  let ownerAccessLost = 0;
  let failed = 0;

  // Sequential recursion rather than a loop: one thread in flight at a time
  // keeps the run inside the root pool and bounds concurrent provider calls.
  const processThreadAt = async (index: number): Promise<void> => {
    const thread = claim.threads.at(index);
    if (!thread || signal.aborted) {
      return;
    }

    const outcome = await compactThread({ database, db, signal, thread });
    if (Result.isError(outcome)) {
      failed += 1;
      captureError(outcome.error, {
        feature: "chat.thread_compactor",
        threadId: thread.threadId,
      });
      logger.warn("scheduler.chat_compactor_failed", {
        "error.type": errorTag(outcome.error),
        "thread.id": thread.threadId,
      });
      // A failed run leaves the checkpoint untouched, so the same delta is
      // still pending. Settling it as failed keeps it queued while backing the
      // retry off, so a thread that fails every time cannot spend a claim slot
      // and a provider call on every tick.
      await settleThread({
        db,
        claim,
        settlement: CHAT_COMPACTION_SETTLEMENT.FAILED,
        thread,
      });
      await processThreadAt(index + 1);
      return;
    }

    switch (outcome.value.type) {
      case "advanced": {
        advanced += 1;
        break;
      }
      case "up-to-date": {
        upToDate += 1;
        break;
      }
      case "no-summary": {
        noSummary += 1;
        logger.warn("scheduler.chat_compactor_no_summary", {
          "thread.id": thread.threadId,
        });
        break;
      }
      case "superseded": {
        superseded += 1;
        break;
      }
      case "anonymized": {
        anonymized += 1;
        break;
      }
      case "owner-access-lost": {
        ownerAccessLost += 1;
        logger.warn("scheduler.chat_compactor_owner_access_lost", {
          "thread.id": thread.threadId,
          "thread.skip_reason": outcome.value.reason,
        });
        break;
      }
      default: {
        outcome.value satisfies never;
        return panic(`Unhandled value: ${String(outcome.value)}`);
      }
    }

    await settleThread({
      db,
      claim,
      settlement: settlementForOutcome(outcome.value),
      thread,
    });
    await processThreadAt(index + 1);
  };

  await processThreadAt(0);

  if (claim.malformedRowCount > 0) {
    // A shape the schema forbids. Skipped rather than aborting the batch, since
    // the lease is already written and the other claims would otherwise sit
    // unsettled until it expired.
    logger.warn("scheduler.chat_compactor_malformed_rows", {
      "thread.malformed": claim.malformedRowCount,
    });
  }

  logger.info("scheduler.chat_compactor", {
    "thread.advanced": advanced,
    "thread.anonymized": anonymized,
    "thread.claimed": claim.threads.length,
    "thread.failed": failed,
    "thread.no_summary": noSummary,
    "thread.owner_access_lost": ownerAccessLost,
    "thread.superseded": superseded,
    "thread.up_to_date": upToDate,
  });

  if (signal.aborted) {
    panic("SchedulerAborted");
  }
};

/**
 * How each outcome leaves the queue.
 *
 *  - `advanced` reschedules only while delta remains; otherwise it drains.
 *  - `up-to-date` drains. It must not reschedule: a delta the planner declines
 *    to summarize would respawn the same no-op run forever. The next send over
 *    the trigger marks the thread due again.
 *  - `no-summary` is a failed attempt, not a completion. The delta is still
 *    unsummarized, so the thread stays queued, behind a backoff so a model that
 *    keeps returning nothing cannot be retried at full rate.
 *  - `superseded` drains, because whatever superseded the run owns the
 *    follow-up: a competing compaction settles itself, and an edit or replay
 *    invalidates the chain from inside a send that re-marks the thread due in
 *    the same request. Requeueing instead would spend a provider call per tick
 *    for as long as a user kept editing, to reach the same state.
 *  - `anonymized` drains: the thread's content no longer leaves for this
 *    request, and the claim never selects it again.
 *  - `owner-access-lost` drains: nothing changes until the owner can read the
 *    thread again, and only the owner's next send marks it due again.
 */
export const settlementForOutcome = (
  outcome: ChatCompactorOutcome,
): ChatCompactionSettlement => {
  switch (outcome.type) {
    case "advanced": {
      return outcome.hasMoreDelta
        ? CHAT_COMPACTION_SETTLEMENT.REQUEUED
        : CHAT_COMPACTION_SETTLEMENT.DRAINED;
    }
    case "up-to-date": {
      return CHAT_COMPACTION_SETTLEMENT.DRAINED;
    }
    case "no-summary": {
      return CHAT_COMPACTION_SETTLEMENT.FAILED;
    }
    case "superseded": {
      return CHAT_COMPACTION_SETTLEMENT.DRAINED;
    }
    case "anonymized": {
      return CHAT_COMPACTION_SETTLEMENT.DRAINED;
    }
    case "owner-access-lost": {
      return CHAT_COMPACTION_SETTLEMENT.DRAINED;
    }
    default: {
      outcome satisfies never;
      return panic(`Unhandled outcome: ${String(outcome)}`);
    }
  }
};

type CompactThreadOptions = {
  database: RlsDatabase<Transaction> | undefined;
  db: SchedulerDb;
  signal: AbortSignal;
  thread: QueuedCompactionThread;
};

type CompactThreadResult = Result<
  ChatCompactorOutcome,
  ChatCompactionError | SafeDbError
>;

const compactThread = async ({
  database,
  db,
  signal,
  thread,
}: CompactThreadOptions): Promise<CompactThreadResult> => {
  const memberDb = createRootMembershipSafeDb(
    { organizationId: thread.organizationId, userId: thread.userId },
    database,
  );
  const safeDb = holdOwnerAccess({ safeDb: memberDb, thread });
  // Checked before the AI settings load so a run for a former member stops
  // early; every later transaction holds the access again.
  const access = await safeDb(async () => await Promise.resolve(null));
  if (Result.isError(access)) {
    const lost = ownerAccessLostOutcome(access.error);
    return lost === null ? Result.err(access.error) : Result.ok(lost);
  }

  // `loadOrgAISettings` throws on a corrupt encrypted configuration, which is a
  // property of one organization. Outside the per-thread boundary that
  // rejection would escape before this thread is settled, leaving the rest of
  // the claimed batch leased until expiry and letting the same poison thread
  // abort the batch again on every run.
  const configError = (cause: unknown) =>
    new ChatCompactionError({
      cause,
      message: "failed to load the organization AI configuration",
      threadId: thread.threadId,
    });
  const configResult = Result.flatten(
    await Result.tryPromise({
      try: async () =>
        (
          await loadOrgAISettings(db, {
            organizationId: thread.organizationId,
            userId: thread.userId,
          })
        ).mapError(configError),
      catch: configError,
    }),
  );
  if (Result.isError(configResult)) {
    return configResult;
  }
  const { orgAIConfig, managedAIResidency } = configResult.value;

  // The thread's sends drew its actions; the drain takes a background slot.
  const admitted = await runScheduledBackgroundWork({
    actionKind: "chat.background",
    organizationId: thread.organizationId,
    userId: thread.userId,
    organizationStateDb: createRootMembershipScopedDb(
      { organizationId: thread.organizationId, userId: thread.userId },
      database,
    ),
    run: async (leaseSignal, admission) => {
      // Sized for the model the admitted tier serves.
      const { preserveTokens, triggerTokens } = resolveChatCompactionBudget({
        chatModelOverride: thread.chatModel ?? undefined,
        orgAIConfig,
        organizationId: thread.organizationId,
        modelTier: admission.modelTier,
      });
      return await runChatThreadCompaction({
        abortSignal: AbortSignal.any([
          AbortSignal.timeout(COMPACTION_TIMEOUT_MS),
          signal,
          leaseSignal,
        ]),
        admission,
        analytics: createTanStackAIAnalyticsCallbacks({
          dataClass: "customer",
          feature: "chat.thread_compaction",
          modelRole: "chat",
          orgAIConfig,
          modelTier: admission.modelTier,
          properties: { organization_id: thread.organizationId },
          sessionId: thread.threadId,
          traceId: Bun.randomUUIDv7(),
          usageMetering: {
            actionType: "background",
            organizationId: thread.organizationId,
            // Usage already incurred is recorded even if the owner has just
            // left; reads and the checkpoint write hold the owner's access.
            safeDb: memberDb,
            serviceTier: "batch",
            userId: thread.userId,
            workspaceId: null,
          },
        }),
        dataWorkspaceIds: thread.dataWorkspaceIds,
        modelId: thread.chatModel ?? undefined,
        orgAIConfig,
        managedAIResidency,
        organizationId: thread.organizationId,
        preserveTokens,
        safeDb,
        threadId: thread.threadId,
        triggerTokens,
      });
    },
  });
  if (Result.isError(admitted)) {
    return Result.err(
      new ChatCompactionError({
        cause: admitted.error,
        message: "chat compaction was not admitted",
        threadId: thread.threadId,
      }),
    );
  }
  const compacted = admitted.value;
  if (Result.isError(compacted)) {
    const lost = ownerAccessLostOutcome(compacted.error);
    return lost === null ? Result.err(compacted.error) : Result.ok(lost);
  }
  return compacted;
};

/** Reported, as the cause of an `UnhandledException` like any other aborted
 *  transaction, when an owner transaction is refused. */
class OwnerAccessLostError extends TaggedError("OwnerAccessLostError")<{
  message: string;
  reason: OwnerAccessLostReason;
}> {}

const OWNER_ACCESS_LOST_MESSAGE = {
  [OWNER_ACCESS_LOST_REASON.ORGANIZATION]:
    "the thread owner is no longer an organization member",
  [OWNER_ACCESS_LOST_REASON.THREAD]:
    "the thread owner can no longer read the thread or one of its matters",
} as const satisfies Record<OwnerAccessLostReason, string>;

/**
 * Hold the owner's access to the thread for the rest of `tx`, or say why the
 * owner no longer has it.
 *
 * Thread RLS checks a thread outside any matter against the organization id
 * alone, so the handle's own scope does not stop a run whose owner has left.
 * Holding the membership rows in the transaction that reads the transcript or
 * writes the checkpoint means a concurrent removal either waits for it or is
 * seen by it.
 */
const holdThreadOwnerAccess = async (
  tx: Transaction,
  { organizationId, threadId, userId }: QueuedCompactionThread,
): Promise<OwnerAccessLostReason | null> => {
  const owner = { organizationId, userId };
  const organization = await holdMemberAccessOnTx(tx, {
    ...owner,
    workspaceIds: [],
  });
  if (organization.type === "not-member") {
    return OWNER_ACCESS_LOST_REASON.ORGANIZATION;
  }
  const scope = (
    await tx
      .select({
        dataWorkspaceIds: chatThreads.dataWorkspaceIds,
        workspaceId: chatThreads.workspaceId,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
      .limit(1)
  ).at(0);
  if (scope === undefined) {
    return OWNER_ACCESS_LOST_REASON.THREAD;
  }
  const matters = [
    ...new Set([
      ...(scope.workspaceId === null ? [] : [scope.workspaceId]),
      ...scope.dataWorkspaceIds,
    ]),
  ];
  if (matters.length === 0) {
    return null;
  }
  const held = await holdMemberAccessOnTx(tx, {
    ...owner,
    workspaceIds: matters,
  });
  return held.type === "held" && held.workspaceIds.length === matters.length
    ? null
    : OWNER_ACCESS_LOST_REASON.THREAD;
};

type HoldOwnerAccessOptions = {
  safeDb: MembershipSafeDb;
  thread: QueuedCompactionThread;
};

/** The owner's handle, with every transaction first holding the owner's
 *  access to the thread and rolled back when it is gone. */
const holdOwnerAccess =
  ({ safeDb, thread }: HoldOwnerAccessOptions): SafeDb =>
  async (fn, retry) => {
    const refusal: { reason: OwnerAccessLostReason | null } = { reason: null };
    const result = await safeDb(async (tx) => {
      refusal.reason = await holdThreadOwnerAccess(tx, thread);
      // Nothing is written yet, but only a rollback ends the transaction
      // without the caller's value.
      return refusal.reason === null ? await fn(tx) : tx.rollback();
    }, retry);
    if (refusal.reason === null || result.isOk()) {
      return result;
    }
    return Result.err(
      new UnhandledException({
        cause: new OwnerAccessLostError({
          message: OWNER_ACCESS_LOST_MESSAGE[refusal.reason],
          reason: refusal.reason,
        }),
      }),
    );
  };

/** The skip outcome for a run an owner transaction aborted, if it was one. */
const ownerAccessLostOutcome = (
  error: ChatCompactionError | SafeDbError,
): ChatCompactorOutcome | null =>
  OwnerAccessLostError.is(error.cause)
    ? { type: "owner-access-lost", reason: error.cause.reason }
    : null;

type ClaimedCompactionBatch = {
  leaseExpiresAt: Date;
  malformedRowCount: number;
  threads: QueuedCompactionThread[];
};

const claimCompactionBatch = async (
  db: SchedulerDb,
): Promise<ClaimedCompactionBatch> => {
  const now = new Date();
  const leaseExpiresAt = new Date(
    now.getTime() + CHAT_COMPACTION_QUEUE_LEASE_MS,
  );
  const rows = executedRows(
    await db.execute(
      buildClaimChatCompactionQueueQuery({ leaseExpiresAt, now }),
    ),
  );
  const { malformedRowCount, threads } = parseChatCompactionQueueRows(rows);
  return { leaseExpiresAt, malformedRowCount, threads };
};

const settleThread = async ({
  db,
  claim,
  settlement,
  thread,
}: {
  db: SchedulerDb;
  claim: ClaimedCompactionBatch;
  settlement: ChatCompactionSettlement;
  thread: QueuedCompactionThread;
}): Promise<void> => {
  await db.execute(
    buildSettleChatCompactionQueueQuery({
      leaseExpiresAt: claim.leaseExpiresAt,
      now: new Date(),
      settlement,
      threadId: thread.threadId,
    }),
  );
};
