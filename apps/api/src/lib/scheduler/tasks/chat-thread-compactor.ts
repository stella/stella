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
 * is then done through a scoped handle carrying that thread's own organization
 * and matter scope, so nothing widens.
 */
import { panic, Result } from "better-result";

import { rootDb } from "@/api/db/root";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { resolveChatCompactionBudget } from "@/api/lib/chat/compaction-budget";
import {
  ChatCompactionError,
  runChatThreadCompaction,
} from "@/api/lib/chat/thread-compaction";
import type { ChatCompactionOutcome } from "@/api/lib/chat/thread-compaction";
import { errorTag } from "@/api/lib/errors/utils";
import { createRootSafeDb } from "@/api/lib/root-scoped-db";
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
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const CHAT_THREAD_COMPACTOR_TASK = "chat.compactThreads" as const;

const COMPACTION_TIMEOUT_MS = 60_000;

export const compactChatThreads: SchedulerTask = async ({ logger, signal }) => {
  const claim = await claimCompactionBatch();

  let advanced = 0;
  let upToDate = 0;
  let superseded = 0;
  let noSummary = 0;
  let failed = 0;

  // Sequential recursion rather than a loop: one thread in flight at a time
  // keeps the run inside the root pool and bounds concurrent provider calls.
  const processThreadAt = async (index: number): Promise<void> => {
    const thread = claim.threads.at(index);
    if (!thread || signal.aborted) {
      return;
    }

    const outcome = await compactThread({ signal, thread });
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
      default: {
        outcome.value satisfies never;
        return panic(`Unhandled value: ${String(outcome.value)}`);
      }
    }

    await settleThread({
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
    "thread.claimed": claim.threads.length,
    "thread.failed": failed,
    "thread.no_summary": noSummary,
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
 */
export const settlementForOutcome = (
  outcome: ChatCompactionOutcome,
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
    default: {
      outcome satisfies never;
      return panic(`Unhandled outcome: ${String(outcome)}`);
    }
  }
};

type CompactThreadOptions = {
  signal: AbortSignal;
  thread: QueuedCompactionThread;
};

const compactThread = async ({
  signal,
  thread,
}: CompactThreadOptions): ReturnType<typeof runChatThreadCompaction> => {
  // `loadOrgAIConfig` throws rather than returning a Result, and a corrupt
  // encrypted configuration is a property of one organization. Outside the
  // per-thread boundary that rejection would escape before this thread is
  // settled, leaving the rest of the claimed batch leased until expiry and
  // letting the same poison thread abort the batch again on every run.
  const configResult = await Result.tryPromise({
    try: async () => await loadOrgAIConfig(thread.organizationId),
    catch: (cause) =>
      new ChatCompactionError({
        cause,
        message: "failed to load the organization AI configuration",
        threadId: thread.threadId,
      }),
  });
  if (Result.isError(configResult)) {
    return configResult;
  }
  const orgAIConfig = configResult.value;

  const { preserveTokens, triggerTokens } = resolveChatCompactionBudget({
    chatModelOverride: thread.chatModel ?? undefined,
    orgAIConfig,
    organizationId: thread.organizationId,
  });

  const safeDb = createRootSafeDb({
    organizationId: thread.organizationId,
    userId: thread.userId,
    workspaceIds: [...thread.dataWorkspaceIds],
  });

  return await runChatThreadCompaction({
    abortSignal: AbortSignal.any([
      AbortSignal.timeout(COMPACTION_TIMEOUT_MS),
      signal,
    ]),
    analytics: createTanStackAIAnalyticsCallbacks({
      feature: "chat.thread_compaction",
      modelRole: "chat",
      orgAIConfig,
      properties: { organization_id: thread.organizationId },
      sessionId: thread.threadId,
      traceId: Bun.randomUUIDv7(),
      usageMetering: {
        actionType: "background",
        organizationId: thread.organizationId,
        safeDb,
        serviceTier: "batch",
        userId: thread.userId,
        workspaceId: null,
      },
    }),
    dataWorkspaceIds: thread.dataWorkspaceIds,
    modelId: thread.chatModel ?? undefined,
    orgAIConfig,
    organizationId: thread.organizationId,
    preserveTokens,
    safeDb,
    threadId: thread.threadId,
    triggerTokens,
  });
};

type ClaimedCompactionBatch = {
  leaseExpiresAt: Date;
  malformedRowCount: number;
  threads: QueuedCompactionThread[];
};

const claimCompactionBatch = async (): Promise<ClaimedCompactionBatch> => {
  const now = new Date();
  const leaseExpiresAt = new Date(
    now.getTime() + CHAT_COMPACTION_QUEUE_LEASE_MS,
  );
  const rows = await rootDb.execute(
    buildClaimChatCompactionQueueQuery({ leaseExpiresAt, now }),
  );
  const { malformedRowCount, threads } = parseChatCompactionQueueRows(rows);
  return { leaseExpiresAt, malformedRowCount, threads };
};

const settleThread = async ({
  claim,
  settlement,
  thread,
}: {
  claim: ClaimedCompactionBatch;
  settlement: ChatCompactionSettlement;
  thread: QueuedCompactionThread;
}): Promise<void> => {
  await rootDb.execute(
    buildSettleChatCompactionQueueQuery({
      leaseExpiresAt: claim.leaseExpiresAt,
      now: new Date(),
      settlement,
      threadId: thread.threadId,
    }),
  );
};
