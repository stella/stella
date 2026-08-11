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
import { Result, TaggedError } from "better-result";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { ReasoningEffort } from "@stll/ai-catalog";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  chatMessages,
  chatThreadCompactions,
  chatThreads,
} from "@/api/db/schema";
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
  FILE_PART_ESTIMATED_TOKENS,
  MAX_SUMMARY_OUTPUT_TOKENS,
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
  role: string;
};

type ChatCompactionCheckpointRow = {
  deltaCursor: string | null;
  id: SafeId<"chatThreadCompaction">;
  summaryMarkdown: string;
  totalSummarizedMessageCount: number;
};

export type ChatCompactionOutcome =
  /** Chain advanced by one step; more delta remains beyond this batch. */
  | { type: "advanced"; hasMoreDelta: boolean; summarizedMessageCount: number }
  /** Nothing to do: the thread is under its trigger, or the delta is empty. */
  | { type: "up-to-date" }
  /** Another run advanced the chain first, or a truncation invalidated it. */
  | { type: "superseded" };

type RunChatThreadCompactionOptions = {
  abortSignal: AbortSignal;
  dataWorkspaceIds: readonly SafeId<"workspace">[];
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

    const checkpoint = yield* Result.await(
      safeDb(async (tx) => await readActiveCheckpointOnTx({ threadId, tx })),
    );

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
      return Result.ok<ChatCompactionOutcome>({ type: "up-to-date" });
    }

    const advanced = yield* Result.await(
      safeDb(
        async (tx) =>
          await advanceCheckpointOnTx({
            expectedCheckpointId: checkpoint?.id ?? null,
            options,
            plan,
            priorTotal: checkpoint?.totalSummarizedMessageCount ?? 0,
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

const selectPreservedTail = (
  messages: readonly DeltaMessage[],
  preserveTokens: number,
): DeltaMessage[] => {
  const preserved: DeltaMessage[] = [];
  let preservedTokens = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages.at(index);
    if (!message) {
      continue;
    }

    const messageTokens = estimateDeltaMessageTokens(message);
    if (
      preserved.length > 0 &&
      preservedTokens + messageTokens > preserveTokens &&
      preserved.at(0)?.role === "user"
    ) {
      break;
    }

    preservedTokens += messageTokens;
    preserved.unshift(message);
  }

  return preserved;
};

type SummarizeDeltaOptions = {
  options: RunChatThreadCompactionOptions;
  plan: Extract<IncrementalCompactionPlan, { type: "compact" }>;
  priorSummary: ChatCompactionCheckpointRow | null;
};

/**
 * Returns `null` rather than an error when the model declines or fails: the
 * stored checkpoint stays put and the delta stays intact, so the next run
 * simply retries the same step.
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
      maxOutputTokens: MAX_SUMMARY_OUTPUT_TOKENS,
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
  expectedCheckpointId: SafeId<"chatThreadCompaction"> | null;
  options: RunChatThreadCompactionOptions;
  plan: Extract<IncrementalCompactionPlan, { type: "compact" }>;
  priorTotal: number;
  summaryMarkdown: string;
  tx: Transaction;
};

/**
 * Retire the checkpoint this run started from and install its replacement, or
 * decline if the chain moved underneath us.
 *
 * The compare-and-set on the active checkpoint id is the idempotence key. It
 * fails closed in both directions that matter: a concurrent run that already
 * advanced the chain leaves a different id, and a message truncation marks the
 * chain stale so no active row is found at all. Either way this returns false
 * and no summary is written twice.
 */
const advanceCheckpointOnTx = async ({
  expectedCheckpointId,
  options,
  plan,
  priorTotal,
  summaryMarkdown,
  tx,
}: AdvanceCheckpointOptions): Promise<boolean> => {
  const { threadId } = options;

  // Serialize concurrent compactions of the same thread behind its row, so the
  // compare-and-set below reads a settled chain rather than racing one.
  await tx
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .for("update");

  const current = await readActiveCheckpointOnTx({ threadId, tx });
  if ((current?.id ?? null) !== expectedCheckpointId) {
    return false;
  }

  const lastSummarized = plan.messagesToSummarize.at(-1);
  const firstSummarized = plan.messagesToSummarize.at(0);
  if (!lastSummarized || !firstSummarized) {
    return false;
  }

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
    totalSummarizedMessageCount: priorTotal + plan.messagesToSummarize.length,
    totalTokens: plan.totalTokens,
    preservedTokens: plan.preservedTokens,
    promptVersion: CHAT_COMPACTION_PROMPT_VERSION,
    // The extraction trigger queues only rows whose completion stamp is null.
    // Stamp checkpoints created during a deployment opt-out so a later
    // re-enable cannot retrospectively mine those conversations.
    memoryExtractedAt: env.FEATURE_AI_MEMORY ? null : new Date(),
  });

  return true;
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
