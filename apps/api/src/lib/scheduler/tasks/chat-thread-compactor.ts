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
  parseChatCompactionQueueRows,
} from "@/api/lib/scheduler/tasks/chat-thread-compactor-queue";
import type { QueuedCompactionThread } from "@/api/lib/scheduler/tasks/chat-thread-compactor-queue";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const CHAT_THREAD_COMPACTOR_TASK = "chat.compactThreads" as const;

const COMPACTION_TIMEOUT_MS = 60_000;

export const compactChatThreads: SchedulerTask = async ({ logger, signal }) => {
  const claim = await claimCompactionBatch();

  let advanced = 0;
  let upToDate = 0;
  let superseded = 0;
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
      // still pending. Settle it back as due; the attempt stamp rotates it
      // behind untouched work so it cannot monopolize the next batch.
      await settleThread({ claim, hasMoreWork: true, thread });
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
      case "superseded": {
        superseded += 1;
        break;
      }
      default: {
        const exhaustive: never = outcome.value;
        return exhaustive;
      }
    }

    await settleThread({
      claim,
      hasMoreWork: hasMoreWorkAfter(outcome.value),
      thread,
    });
    await processThreadAt(index + 1);
  };

  await processThreadAt(0);

  logger.info("scheduler.chat_compactor", {
    "thread.advanced": advanced,
    "thread.claimed": claim.threads.length,
    "thread.failed": failed,
    "thread.superseded": superseded,
    "thread.up_to_date": upToDate,
  });

  if (signal.aborted) {
    panic("SchedulerAborted");
  }
};

/**
 * Whether the thread goes back on the queue immediately.
 *
 * Only a run that made progress and knows more delta remains reschedules
 * itself. `up-to-date` deliberately does not: a delta the planner declines to
 * summarize would otherwise respawn the same no-op run forever. The next send
 * over the trigger marks the thread due again.
 */
const hasMoreWorkAfter = (outcome: ChatCompactionOutcome): boolean =>
  outcome.type === "advanced" && outcome.hasMoreDelta;

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
  return { leaseExpiresAt, threads: parseChatCompactionQueueRows(rows) };
};

const settleThread = async ({
  claim,
  hasMoreWork,
  thread,
}: {
  claim: ClaimedCompactionBatch;
  hasMoreWork: boolean;
  thread: QueuedCompactionThread;
}): Promise<void> => {
  await rootDb.execute(
    buildSettleChatCompactionQueueQuery({
      hasMoreWork,
      leaseExpiresAt: claim.leaseExpiresAt,
      now: new Date(),
      threadId: thread.threadId,
    }),
  );
};
