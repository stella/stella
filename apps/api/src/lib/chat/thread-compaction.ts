/**
 * Durable incremental thread compaction.
 *
 * A thread's checkpoint chain is a sequence of `chat_thread_compactions` rows,
 * exactly one of which is `active` (enforced by a partial unique index). Each
 * row carries the merged summary of everything up to its `delta_cursor`, a
 * keyset cursor over `(chat_messages.created_at, id)`.
 *
 * One run advances that chain by exactly one step:
 *
 *   1. read the active checkpoint (summary + cursor);
 *   2. read a BOUNDED batch of messages after the cursor;
 *   3. ask the model to merge the checkpoint with that batch;
 *   4. in one transaction, verify the active checkpoint is still the one read
 *      in step 1, mark it stale, and insert the replacement.
 *
 * No step ever reads lifetime history: the delta batch is capped at
 * `CHAT_COMPACTION_DELTA_BATCH_MAX` rows, and everything before the cursor is
 * represented only by the previous summary.
 *
 * Crash safety comes from step 4 being the only write. A crash before it
 * commits leaves the previous checkpoint active, so a rerun recomputes the same
 * delta and writes once. A crash after it commits leaves a different active
 * checkpoint id, so a rerun of the same claim compares unequal and declines to
 * write — the summary can never be applied twice, and the delta is never lost.
 */
import { panic, Result, TaggedError } from "better-result";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { ReasoningEffort } from "@stll/ai-catalog";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  CHAT_COMPACTION_MEMORY_ELIGIBILITY,
  CHAT_COMPACTION_MEMORY_EXTRACTABLE,
  chatMessages,
  chatThreadCompactions,
  chatThreads,
} from "@/api/db/schema";
import type { ChatCompactionMemoryEligibility } from "@/api/db/schema";
import { env } from "@/api/env";
import { resolveCaching, type OrgAIConfig } from "@/api/lib/ai-config";
import type { TanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  CHAT_COMPACTION_PROMPT_VERSION,
  CHAT_INCREMENTAL_COMPACTION_SYSTEM_PROMPT,
  parseChatCompactionSummary,
  renderIncrementalCompactionPrompt,
} from "@/api/lib/chat/compaction-summary";
import type { IncrementalSummaryPrompt } from "@/api/lib/chat/compaction-summary";
import {
  COMPACTION_GENERATION_POLICY,
  FILE_PART_ESTIMATED_TOKENS,
  MAX_TEXT_PART_CHARS,
  MESSAGE_OVERHEAD_TOKENS,
  estimateTextTokens,
  renderTaggedValue,
  safeStringify,
  truncateForCompaction,
} from "@/api/lib/chat/compaction-tokens";
import { chatMessageCursorCodec } from "@/api/lib/chat/message-cursor";
import type { TimestampIdCursor } from "@/api/lib/db-pagination";
import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";

/**
 * Rows one run may pull past the checkpoint cursor. The bound is what makes a
 * run's cost independent of thread age: a thread a hundred batches behind is
 * caught up over a hundred runs, never in one unbounded read.
 */
export const CHAT_COMPACTION_DELTA_BATCH_MAX = 200;

export class ChatCompactionError extends TaggedError("ChatCompactionError")<{
  message: string;
  cause?: unknown;
  threadId: SafeId<"chatThread">;
}> {}

type PersistedMessageContent = typeof chatMessages.$inferSelect.content;

/**
 * A message as the compactor sees it: a persisted row plus its encoded cursor.
 * The compactor never hydrates `ChatMessage`, so it stays free of the chat
 * slice and can live beside the scheduler that drives it.
 */
type DeltaMessage = {
  content: PersistedMessageContent;
  /** Raw `to_char` cursor value; encoded through the codec before storage. */
  cursorValue: string;
  id: SafeId<"chatMessage">;
  /**
   * The message's own memory opt-out, captured when its content was written.
   * Carried into the checkpoint so a summary that folds this message in can
   * never be mined later, whatever the deployment flag says by then.
   */
  memoryExtractionEligible: boolean;
  role: string;
};

type ChatCompactionCheckpointRow = {
  deltaCursor: string | null;
  id: SafeId<"chatThreadCompaction">;
  memoryEligibility: ChatCompactionMemoryEligibility;
  summaryMarkdown: string;
  totalSummarizedMessageCount: number;
};

/**
 * Everything the compactor must observe before summarizing and re-observe
 * before writing. Both halves matter: the checkpoint id catches a competing
 * compaction, and the epoch catches a message edit or replay, including on a
 * thread with no checkpoint where the id comparison is `null === null`.
 */
type ChatCompactionChainState = {
  checkpoint: ChatCompactionCheckpointRow | null;
  epoch: number;
};

export type ChatCompactionOutcome =
  /** Chain advanced by one step; more delta remains beyond this batch. */
  | { type: "advanced"; hasMoreDelta: boolean; summarizedMessageCount: number }
  /** Nothing to do: the thread is under its trigger, or the delta is empty. */
  | { type: "up-to-date" }
  /**
   * The model returned nothing usable, so the delta is still unsummarized and
   * the same step has to run again. Distinct from `up-to-date` on purpose: an
   * empty summary is a failed attempt, and reporting it as completion would
   * settle the thread and leave the delta unsummarized until some later send
   * happened to re-enqueue it.
   */
  | { type: "no-summary" }
  /** Another run advanced the chain first, or a truncation invalidated it. */
  | { type: "superseded" };

type RunChatThreadCompactionOptions = {
  abortSignal: AbortSignal;
  dataWorkspaceIds: readonly SafeId<"workspace">[];
  /**
   * Whether this deployment may derive AI memory from chat. Passed in rather
   * than read from `env` here so the value that lands on the checkpoint is the
   * one the caller observed, and so the re-enable path is exercisable.
   * Defaults to the deployment flag.
   */
  extractionFeatureEnabled?: boolean | undefined;
  modelId?: string | undefined;
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
  preserveTokens: number;
  reasoningEffort?: ReasoningEffort | undefined;
  safeDb: SafeDb;
  /** Test seam. Defaults to the real structured-summary model call. */
  summarize?: ChatCompactionSummarize | undefined;
  threadId: SafeId<"chatThread">;
  triggerTokens: number;
  analytics?: ChatCompactionAnalytics | undefined;
};

export type ChatCompactionSummarize = (
  prompt: IncrementalSummaryPrompt,
) => Promise<string>;

type ChatCompactionAnalytics = Pick<
  TanStackAIAnalyticsCallbacks,
  "captureError" | "middleware"
>;

/**
 * Advance one thread's checkpoint chain by a single bounded step.
 *
 * Every failure mode returns a `Result` rather than throwing, so the scheduler
 * can stamp the attempt and move to the next thread without a partial write.
 */
export const runChatThreadCompaction = async (
  options: RunChatThreadCompactionOptions,
): Promise<Result<ChatCompactionOutcome, ChatCompactionError | SafeDbError>> =>
  await Result.gen(async function* () {
    const { safeDb, threadId } = options;

    const observed = yield* Result.await(
      safeDb(async (tx) => await readChainStateOnTx({ threadId, tx })),
    );
    const { checkpoint } = observed;

    const delta = yield* Result.await(
      safeDb(
        async (tx) =>
          await readCompactionDeltaOnTx({
            cursor: decodeCheckpointCursor(checkpoint),
            threadId,
            tx,
          }),
      ),
    );

    const plan = planIncrementalCompaction({
      delta,
      preserveTokens: options.preserveTokens,
      priorSummaryTokens: estimateSummaryTokens(checkpoint),
      triggerTokens: options.triggerTokens,
    });
    if (plan.type === "none") {
      return Result.ok<ChatCompactionOutcome>({ type: "up-to-date" });
    }

    const summaryMarkdown = yield* Result.await(
      summarizeDelta({ options, plan, priorSummary: checkpoint }),
    );
    if (summaryMarkdown === null) {
      return Result.ok<ChatCompactionOutcome>({ type: "no-summary" });
    }

    const advanced = yield* Result.await(
      safeDb(
        async (tx) =>
          await advanceCheckpointOnTx({
            observed,
            options,
            plan,
            summaryMarkdown,
            tx,
          }),
      ),
    );

    return Result.ok<ChatCompactionOutcome>(
      advanced
        ? {
            type: "advanced",
            hasMoreDelta: plan.hasMoreDelta,
            summarizedMessageCount: plan.messagesToSummarize.length,
          }
        : { type: "superseded" },
    );
  });

const readActiveCheckpointOnTx = async ({
  threadId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<ChatCompactionCheckpointRow | null> => {
  const row = await tx
    .select({
      deltaCursor: chatThreadCompactions.deltaCursor,
      id: chatThreadCompactions.id,
      memoryEligibility: chatThreadCompactions.memoryEligibility,
      summaryMarkdown: chatThreadCompactions.summaryMarkdown,
      totalSummarizedMessageCount:
        chatThreadCompactions.totalSummarizedMessageCount,
    })
    .from(chatThreadCompactions)
    .where(
      and(
        eq(chatThreadCompactions.threadId, threadId),
        eq(chatThreadCompactions.status, "active"),
      ),
    )
    .orderBy(desc(chatThreadCompactions.createdAt))
    .limit(1);

  return row.at(0) ?? null;
};

/**
 * Read the chain's active checkpoint and the thread's invalidation epoch.
 *
 * Read together and compared together: a run that observed one but not the
 * other could still write a summary built from content an edit has since
 * replaced.
 */
const readChainStateOnTx = async ({
  threadId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<ChatCompactionChainState> => {
  const [checkpoint, epoch] = await Promise.all([
    readActiveCheckpointOnTx({ threadId, tx }),
    readCompactionEpochOnTx({ lock: false, threadId, tx }),
  ]);
  return { checkpoint, epoch };
};

/**
 * The thread's invalidation epoch, optionally taking the row lock that
 * serializes concurrent compactions of the same thread.
 *
 * Returns null when the thread is gone, which the caller treats the same way
 * as a changed epoch: there is nothing left to checkpoint.
 */
const readCompactionEpochOnTx = async ({
  lock,
  threadId,
  tx,
}: {
  lock: boolean;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<number> => {
  const query = tx
    .select({ compactionEpoch: chatThreads.compactionEpoch })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  // Awaited inside each branch rather than `await (lock ? a : b)`: the ternary
  // form makes the compiler build the union of two full Drizzle builder types
  // before awaiting it, which on its own pushed apps/api past its
  // instantiation budget. Awaiting first leaves it unioning two row arrays.
  const rows = lock ? await query.for("update") : await query;
  // A missing thread cannot match any observed epoch, so the advance declines.
  return rows.at(0)?.compactionEpoch ?? MISSING_THREAD_EPOCH;
};

/**
 * Sentinel for "this thread no longer exists". Never equals a real epoch,
 * which starts at zero and only increases.
 */
const MISSING_THREAD_EPOCH = -1;

const decodeCheckpointCursor = (
  checkpoint: ChatCompactionCheckpointRow | null,
): TimestampIdCursor<SafeId<"chatMessage">> | null =>
  checkpoint?.deltaCursor
    ? chatMessageCursorCodec.decode(checkpoint.deltaCursor)
    : null;

type CompactionDelta = {
  messages: DeltaMessage[];
  /**
   * The row immediately after the batch, when the thread holds more. Its
   * presence is how a run knows it is still behind, and its id anchors the
   * checkpoint's `firstKept` without a second query.
   */
  nextMessage: DeltaMessage | null;
};

/**
 * Read one bounded batch of messages after the checkpoint cursor, oldest-first.
 *
 * Reads `CHAT_COMPACTION_DELTA_BATCH_MAX + 1` rows and keeps the extra one as
 * `nextMessage` instead of counting the tail, so "is this thread still behind?"
 * and "which rows do I summarize?" come from the same single query.
 */
const readCompactionDeltaOnTx = async ({
  cursor,
  threadId,
  tx,
}: {
  cursor: TimestampIdCursor<SafeId<"chatMessage">> | null;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<CompactionDelta> => {
  const rows = await tx
    .select({
      content: chatMessages.content,
      cursorValue: chatMessageCursorCodec.cursorValue.as("created_at_cursor"),
      id: chatMessages.id,
      memoryExtractionEligible: chatMessages.memoryExtractionEligible,
      role: chatMessages.role,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, threadId),
        cursor === null
          ? undefined
          : chatMessageCursorCodec.keysetAfter({
              cursor,
              idColumn: chatMessages.id,
              direction: "ascending",
            }),
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
    .limit(CHAT_COMPACTION_DELTA_BATCH_MAX + 1);

  return {
    messages: rows.slice(0, CHAT_COMPACTION_DELTA_BATCH_MAX),
    nextMessage: rows.at(CHAT_COMPACTION_DELTA_BATCH_MAX) ?? null,
  };
};

type IncrementalCompactionPlan =
  | { type: "none" }
  | {
      /**
       * Cursor this run leaves behind: the last row it consumed. Everything at
       * or before it is represented by the new summary, so the next delta read
       * and the next history window both start here.
       */
      advanceCursor: string;
      /** Row the next window starts at; anchors the stored summary. */
      firstKeptMessageId: SafeId<"chatMessage">;
      hasMoreDelta: boolean;
      messagesToSummarize: DeltaMessage[];
      preservedTokens: number;
      totalTokens: number;
      type: "compact";
    };

/**
 * Decide how much of the delta this run folds into the summary.
 *
 * Two shapes, both of which advance the cursor by at least one message:
 *
 *  - more delta beyond the batch: the messages worth preserving verbatim are
 *    not in this batch, so summarize all of it and anchor `firstKept` on the
 *    row that follows;
 *  - batch runs to the end of the thread: keep the newest tail within
 *    `preserveTokens` (at least one message, so `firstKept` stays resolvable)
 *    and summarize the prefix ahead of it.
 *
 * `none` means "stop", not "retry": a delta of provider-invisible rows would
 * otherwise let the queue respawn itself forever.
 */
const planIncrementalCompaction = ({
  delta,
  preserveTokens,
  priorSummaryTokens,
  triggerTokens,
}: {
  delta: CompactionDelta;
  preserveTokens: number;
  priorSummaryTokens: number;
  triggerTokens: number;
}): IncrementalCompactionPlan => {
  const hasMoreDelta = delta.nextMessage !== null;
  const visible = delta.messages.filter(
    (message) => estimateDeltaMessageTokens(message) > 0,
  );
  const totalTokens =
    priorSummaryTokens +
    visible.reduce(
      (total, message) => total + estimateDeltaMessageTokens(message),
      0,
    );

  if (!hasMoreDelta && totalTokens <= triggerTokens) {
    return { type: "none" };
  }

  // A middle slice holds none of the messages worth preserving verbatim, so it
  // is summarized whole and the cursor jumps to the end of the batch. A final
  // slice keeps its newest tail and stops the cursor just before it.
  const preserved = hasMoreDelta
    ? []
    : selectPreservedTail(visible, preserveTokens);
  const messagesToSummarize = visible.slice(
    0,
    visible.length - preserved.length,
  );
  const lastSummarized = messagesToSummarize.at(-1);
  if (!lastSummarized) {
    return { type: "none" };
  }

  const boundary = resolveCompactionBoundary({
    delta,
    lastSummarized,
    preserved,
  });
  if (boundary === null) {
    return { type: "none" };
  }

  return {
    advanceCursor: boundary.cursor,
    firstKeptMessageId: boundary.firstKeptMessageId,
    hasMoreDelta,
    messagesToSummarize,
    preservedTokens: preserved.reduce(
      (total, message) => total + estimateDeltaMessageTokens(message),
      0,
    ),
    totalTokens,
    type: "compact",
  };
};

/**
 * Where this run stops: the last row it consumed, and the first row it did not.
 *
 * With more delta beyond the batch those are the batch's final row and the
 * lookahead row; otherwise they are the row before the preserved tail and the
 * tail's first row. Returns null when neither exists, which leaves the plan at
 * `none` rather than writing a checkpoint with no boundary.
 */
const resolveCompactionBoundary = ({
  delta,
  lastSummarized,
  preserved,
}: {
  delta: CompactionDelta;
  lastSummarized: DeltaMessage;
  preserved: readonly DeltaMessage[];
}): { cursor: string; firstKeptMessageId: SafeId<"chatMessage"> } | null => {
  const { nextMessage } = delta;
  if (nextMessage !== null) {
    const lastInBatch = delta.messages.at(-1);
    return lastInBatch
      ? {
          cursor: encodeDeltaCursor(lastInBatch),
          firstKeptMessageId: nextMessage.id,
        }
      : null;
  }

  const firstKept = preserved.at(0);
  return firstKept
    ? {
        cursor: encodeDeltaCursor(lastSummarized),
        firstKeptMessageId: firstKept.id,
      }
    : null;
};

/**
 * Encode a row's `(created_at, id)` pair through the codec that will decode it.
 * The raw `to_char` value alone is not a cursor: storing it would decode to
 * null on the next run, silently restarting the delta read at message zero.
 */
const encodeDeltaCursor = (message: DeltaMessage): string =>
  chatMessageCursorCodec.encode(message.cursorValue, message.id);

/**
 * The newest messages to keep verbatim, walking back from the end of the batch.
 *
 * Two bounds, and both have to hold:
 *
 *  - the token budget, which stops the walk. It is the only stopping condition:
 *    an earlier version also required the preserved window to begin on a user
 *    turn before it would stop, which is not a budget property at all. A run of
 *    assistant messages at the boundary kept the walk going past the budget by
 *    an unbounded amount, and in the worst case consumed the whole batch, which
 *    left nothing to summarize and stalled a thread that was over its trigger.
 *  - at most `messages.length - 1` messages, so the plan always has something
 *    to summarize and the cursor can always advance.
 *
 * The user-turn boundary survives as a preference, applied by trimming rather
 * than extending: a preserved window that starts mid-exchange is shortened to
 * the next user turn, which moves those messages into the summary instead. A
 * tail with no user turn at all is left alone, since it still has to anchor the
 * checkpoint.
 */
const selectPreservedTail = (
  messages: readonly DeltaMessage[],
  preserveTokens: number,
): DeltaMessage[] => {
  const maxPreserved = Math.max(messages.length - 1, 0);
  const preserved: DeltaMessage[] = [];
  let preservedTokens = 0;

  for (
    let index = messages.length - 1;
    index >= 0 && preserved.length < maxPreserved;
    index -= 1
  ) {
    const message = messages.at(index);
    if (!message) {
      continue;
    }

    const messageTokens = estimateDeltaMessageTokens(message);
    // The first message is admitted regardless, so the checkpoint always has a
    // row to anchor `firstKept` on even when one message exceeds the budget.
    if (
      preserved.length > 0 &&
      preservedTokens + messageTokens > preserveTokens
    ) {
      break;
    }

    preservedTokens += messageTokens;
    preserved.unshift(message);
  }

  return trimToUserTurn(preserved);
};

/**
 * Shorten a preserved window so it begins on a user turn. Returns it unchanged
 * when it already does, or when it contains no user turn to trim to.
 */
const trimToUserTurn = (preserved: readonly DeltaMessage[]): DeltaMessage[] => {
  const firstUserIndex = preserved.findIndex(
    (message) => message.role === "user",
  );
  return firstUserIndex <= 0 ? [...preserved] : preserved.slice(firstUserIndex);
};

type SummarizeDeltaOptions = {
  options: RunChatThreadCompactionOptions;
  plan: Extract<IncrementalCompactionPlan, { type: "compact" }>;
  priorSummary: ChatCompactionCheckpointRow | null;
};

/**
 * Returns `null` rather than an error when the model produces nothing usable.
 * The stored checkpoint stays put and the delta stays intact; the caller turns
 * that into a `no-summary` outcome so the thread is retried rather than settled
 * as complete.
 */
const summarizeDelta = async ({
  options,
  plan,
  priorSummary,
}: SummarizeDeltaOptions): Promise<
  Result<string | null, ChatCompactionError>
> => {
  const summarize = options.summarize ?? createModelSummarizer(options);
  const summaryResult = await Result.tryPromise({
    try: async () =>
      await summarize({
        newMessages: renderDeltaTranscript(plan.messagesToSummarize),
        previousCheckpoint: priorSummary?.summaryMarkdown ?? null,
      }),
    catch: (cause) =>
      new ChatCompactionError({
        message: "Failed to summarize chat compaction delta",
        cause,
        threadId: options.threadId,
      }),
  });
  if (Result.isError(summaryResult)) {
    return Result.err(summaryResult.error);
  }

  const summaryMarkdown = summaryResult.value.trim();
  return Result.ok(summaryMarkdown.length === 0 ? null : summaryMarkdown);
};

const createModelSummarizer =
  (options: RunChatThreadCompactionOptions): ChatCompactionSummarize =>
  async (prompt) =>
    await generateTanStackTextForRole({
      abortSignal: options.abortSignal,
      analytics: options.analytics,
      caching: resolveCaching({
        promptCachingEnabled: false,
        role: "chat",
        scopeKey: null,
      }),
      ...COMPACTION_GENERATION_POLICY,
      modelId: options.modelId,
      organizationId: options.organizationId,
      orgAIConfig: options.orgAIConfig,
      reasoningEffort: options.reasoningEffort,
      prompt: renderIncrementalCompactionPrompt(prompt),
      role: "chat",
      serviceTier: "batch",
      system: CHAT_INCREMENTAL_COMPACTION_SYSTEM_PROMPT,
      systemPromptOrigin: "server-built",
      temperature: 0,
      // The thread's own matter scope: the summarizer must not see raw
      // workspace ids, and no wider set is in scope for a persisted turn.
      tenantWorkspaceIds: options.dataWorkspaceIds,
    });

type AdvanceCheckpointOptions = {
  observed: ChatCompactionChainState;
  options: RunChatThreadCompactionOptions;
  plan: Extract<IncrementalCompactionPlan, { type: "compact" }>;
  summaryMarkdown: string;
  tx: Transaction;
};

/**
 * Retire the checkpoint this run started from and install its replacement, or
 * decline if the chain moved underneath us.
 *
 * Two compare-and-sets, both against state read before summarization:
 *
 *  - the active checkpoint id, which catches a competing compaction that
 *    already advanced the chain and is the idempotence key for a crashed run;
 *  - the thread's invalidation epoch, which catches a message edit or replay.
 *    It is the only guard that means anything on a thread with no checkpoint:
 *    there is no row for invalidation to mark stale, so the id comparison is
 *    `null === null` and would accept a summary built from replaced content,
 *    then advance the cursor past the corrected row so no later run revisits it.
 */
const advanceCheckpointOnTx = async ({
  observed,
  options,
  plan,
  summaryMarkdown,
  tx,
}: AdvanceCheckpointOptions): Promise<boolean> => {
  const { threadId } = options;

  // Serialize concurrent compactions of the same thread behind its row, so the
  // comparisons below read a settled chain rather than racing one.
  const currentEpoch = await readCompactionEpochOnTx({
    lock: true,
    threadId,
    tx,
  });
  if (currentEpoch !== observed.epoch) {
    return false;
  }

  const current = await readActiveCheckpointOnTx({ threadId, tx });
  if ((current?.id ?? null) !== (observed.checkpoint?.id ?? null)) {
    return false;
  }

  const lastSummarized = plan.messagesToSummarize.at(-1);
  const firstSummarized = plan.messagesToSummarize.at(0);
  if (!lastSummarized || !firstSummarized) {
    // Unreachable: the planner returns `none` for an empty summary set, so a
    // "compact" plan always has messages. Returning false here would have the
    // scheduler read a programmer error as ordinary concurrent progress and
    // settle the thread as if another run had won.
    return panic(
      "compaction plan of type 'compact' has no messages to summarize",
    );
  }

  const memoryEligibility = resolveCheckpointMemoryEligibility({
    extractionFeatureEnabled:
      options.extractionFeatureEnabled ?? env.FEATURE_AI_MEMORY,
    previous: observed.checkpoint?.memoryEligibility ?? null,
    segmentMessages: plan.messagesToSummarize,
  });

  // audit: skip — derived compaction checkpoint cache; no user-authored state change
  await tx
    .update(chatThreadCompactions)
    .set({ status: "stale" })
    .where(
      and(
        eq(chatThreadCompactions.threadId, threadId),
        eq(chatThreadCompactions.status, "active"),
      ),
    );

  // audit: skip — derived compaction checkpoint cache; no user-authored state change
  await tx.insert(chatThreadCompactions).values({
    id: createSafeId<"chatThreadCompaction">(),
    threadId,
    status: "active",
    summary: parseChatCompactionSummary(summaryMarkdown),
    summaryMarkdown,
    firstSummarizedMessageId: firstSummarized.id,
    lastSummarizedMessageId: lastSummarized.id,
    firstKeptMessageId: plan.firstKeptMessageId,
    deltaCursor: plan.advanceCursor,
    summarizedMessageCount: plan.messagesToSummarize.length,
    totalSummarizedMessageCount:
      (observed.checkpoint?.totalSummarizedMessageCount ?? 0) +
      plan.messagesToSummarize.length,
    totalTokens: plan.totalTokens,
    preservedTokens: plan.preservedTokens,
    promptVersion: CHAT_COMPACTION_PROMPT_VERSION,
    memoryEligibility,
    // The extraction trigger queues only rows whose completion stamp is null,
    // so stamping here is what keeps a non-eligible summary out of the queue
    // permanently. The reason lives in `memoryEligibility`; this column only
    // records that the decision was made.
    memoryExtractedAt: CHAT_COMPACTION_MEMORY_EXTRACTABLE[memoryEligibility]
      ? null
      : new Date(),
  });

  return true;
};

type ResolveCheckpointMemoryEligibilityOptions = {
  extractionFeatureEnabled: boolean;
  /** The chain's current verdict, or null on a thread's first compaction. */
  previous: ChatCompactionMemoryEligibility | null;
  segmentMessages: readonly Pick<DeltaMessage, "memoryExtractionEligible">[];
};

/**
 * The extractability verdict for the checkpoint this run is about to write.
 *
 * Monotone by construction: an ineligible chain keeps its original reason
 * rather than being re-evaluated, because the content that caused the verdict
 * survives in every later summary. That is the whole point of recording it —
 * re-deriving extractability from the current deployment flag is what let a
 * re-enable reach content from an opted-out period.
 */
export const resolveCheckpointMemoryEligibility = ({
  extractionFeatureEnabled,
  previous,
  segmentMessages,
}: ResolveCheckpointMemoryEligibilityOptions): ChatCompactionMemoryEligibility => {
  if (previous !== null && !CHAT_COMPACTION_MEMORY_EXTRACTABLE[previous]) {
    return previous;
  }

  if (
    !segmentMessages.every(
      ({ memoryExtractionEligible }) => memoryExtractionEligible,
    )
  ) {
    return CHAT_COMPACTION_MEMORY_ELIGIBILITY.MESSAGE_OPTED_OUT;
  }

  return extractionFeatureEnabled
    ? CHAT_COMPACTION_MEMORY_ELIGIBILITY.ELIGIBLE
    : CHAT_COMPACTION_MEMORY_ELIGIBILITY.CONSENT_INACTIVE;
};

const estimateSummaryTokens = (
  checkpoint: ChatCompactionCheckpointRow | null,
): number =>
  checkpoint === null
    ? 0
    : MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(checkpoint.summaryMarkdown);

/**
 * Token estimate for a persisted row, mirroring the send path's per-message
 * estimator: fixed overhead, chars/4 for text, a flat charge per attachment.
 * A row with no renderable parts scores 0 and is dropped from the plan, the
 * same way the send path skips provider-invisible messages.
 */
const estimateDeltaMessageTokens = (message: DeltaMessage): number => {
  const parts = deltaMessageParts(message);
  if (parts.length === 0) {
    return 0;
  }

  return parts
    .map(estimateDeltaPartTokens)
    .reduce((total, partTokens) => total + partTokens, MESSAGE_OVERHEAD_TOKENS);
};

const estimateDeltaPartTokens = (part: unknown): number => {
  const text = persistedTextPartContent(part);
  if (text !== null) {
    return estimateTextTokens(text);
  }
  if (isPersistedAttachmentPart(part)) {
    return FILE_PART_ESTIMATED_TOKENS;
  }
  return estimateTextTokens(safeStringify(part));
};

const deltaMessageParts = (message: DeltaMessage): unknown[] =>
  Array.isArray(message.content.data) ? message.content.data : [];

/**
 * Render the summarized slice for the model. Deliberately the same envelope
 * the send path's transcript renderer uses, so a checkpoint written by the
 * compactor reads to the model exactly like one written inline used to.
 */
const renderDeltaTranscript = (messages: readonly DeltaMessage[]): string => {
  const rendered: string[] = [];

  for (const message of messages) {
    const parts = deltaMessageParts(message);
    if (parts.length === 0) {
      continue;
    }

    rendered.push(
      [
        `<message index="${rendered.length + 1}" role="${message.role}" id="${message.id}">`,
        ...parts.map(renderDeltaPart),
        "</message>",
      ].join("\n"),
    );
  }

  return rendered.join("\n\n");
};

const renderDeltaPart = (part: unknown): string => {
  const text = persistedTextPartContent(part);
  if (text !== null) {
    return renderTaggedValue(
      "text",
      truncateForCompaction(text, MAX_TEXT_PART_CHARS),
    );
  }

  if (isPersistedAttachmentPart(part)) {
    return renderTaggedValue(
      "file",
      "content: omitted; attachments are not inlined during compaction",
    );
  }

  return renderTaggedValue(
    partTypeTag(part),
    truncateForCompaction(safeStringify(part), MAX_TEXT_PART_CHARS),
  );
};

const partTypeTag = (part: unknown): string => {
  if (typeof part === "object" && part !== null && "type" in part) {
    const { type } = part;
    return typeof type === "string" ? type : "part";
  }
  return "part";
};

/**
 * Text of a persisted part, across both persisted content versions (`content`
 * in v2, `text` in the legacy v1 payload). Returns null for non-text parts.
 */
const persistedTextPartContent = (part: unknown): string | null => {
  if (typeof part !== "object" || part === null || !("type" in part)) {
    return null;
  }
  if (part.type !== "text") {
    return null;
  }
  if ("content" in part && typeof part.content === "string") {
    return part.content;
  }
  if ("text" in part && typeof part.text === "string") {
    return part.text;
  }
  return null;
};

const isPersistedAttachmentPart = (part: unknown): boolean => {
  if (typeof part !== "object" || part === null || !("type" in part)) {
    return false;
  }
  return part.type === "file" || part.type === "image";
};

/**
 * Mark a thread as needing compaction. Idempotent, and deliberately
 * unconditional: overwriting an in-flight lease is what makes the compactor's
 * compare-and-set settlement decline to clear a wakeup that arrived mid-run.
 *
 * Written as a statement rather than through the query builder so it touches
 * only the queue column. `chat_threads` carries `$onUpdate` columns — the
 * `updated_at` stamp that orders the thread list and the rollback token that
 * governs disconnect compensation — and a builder update would rewrite both as
 * a side effect of enqueuing.
 */
export const markChatThreadCompactionDue = async ({
  threadId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<void> => {
  // audit: skip — derived compaction queue address; no user-authored state change
  await tx.execute(
    sql`update ${chatThreads} set compaction_scheduled_at = now() where ${chatThreads.id} = ${threadId}`,
  );
};
