import { panic } from "better-result";
import type { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDbError, SafeDbOrTx } from "@/api/db/safe-db";
import { withScopedTx } from "@/api/db/safe-db";
import { chatThreadCompactions, chatThreads } from "@/api/db/schema";
import { createCompactionSummaryMessage } from "@/api/handlers/chat/compaction";
import type { MessagePersistencePlan } from "@/api/handlers/chat/persist-message";
import type {
  ChatCompactionSummary,
  ChatMessage,
} from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";

export type ChatThreadCompactionCheckpoint = {
  /**
   * Encoded keyset cursor of the last message the chain has summarized. Null
   * on chains written before the cursor landed, which read from the start of
   * the thread until the compactor re-anchors them.
   */
  deltaCursor: string | null;
  firstKeptMessageId: SafeId<"chatMessage">;
  id: SafeId<"chatThreadCompaction">;
  summarizedMessageCount: number;
  summary: ChatCompactionSummary;
  summaryMarkdown: string;
  /** Messages the whole chain has folded in, across every run. */
  totalSummarizedMessageCount: number;
};

type ReadLatestChatCompactionOnTxProps = {
  threadId: SafeId<"chatThread">;
  tx: Transaction;
};

/**
 * Core query, callable directly against an already-open transaction so
 * callers that share one scoped tx (e.g. get-messages.ts) can run it
 * without paying for a second `set_config`. Any thrown error is left to
 * propagate to that transaction's own `safeDb` catch-all.
 */
export const readLatestChatCompactionOnTx = async ({
  threadId,
  tx,
}: ReadLatestChatCompactionOnTxProps): Promise<ChatThreadCompactionCheckpoint | null> => {
  const row = await tx.query.chatThreadCompactions.findFirst({
    where: {
      threadId: { eq: threadId },
      status: { eq: "active" },
    },
    columns: {
      deltaCursor: true,
      id: true,
      firstKeptMessageId: true,
      summarizedMessageCount: true,
      summary: true,
      summaryMarkdown: true,
      totalSummarizedMessageCount: true,
    },
    orderBy: { createdAt: "desc" },
  });
  return row ?? null;
};

type ReadLatestChatCompactionProps = SafeDbOrTx & {
  threadId: SafeId<"chatThread">;
};

export const readLatestChatCompaction = async ({
  threadId,
  ...handle
}: ReadLatestChatCompactionProps): Promise<
  Result<ChatThreadCompactionCheckpoint | null, SafeDbError>
> =>
  await withScopedTx(
    handle,
    async (tx) => await readLatestChatCompactionOnTx({ threadId, tx }),
  );

type ApplyChatCompactionCheckpointProps = {
  checkpoint: ChatThreadCompactionCheckpoint;
  messages: ChatMessage[];
};

/**
 * Put the stored summary in front of the messages the model will see.
 *
 * The history window seeks past the checkpoint cursor, so `messages` is already
 * the post-checkpoint tail and the summary simply goes ahead of it. When
 * `firstKeptMessageId` does appear — a window read against an older checkpoint
 * than the one resolved here — the prefix before it is dropped, because the
 * newer summary already covers those messages and repeating them verbatim
 * would double them in the prompt.
 *
 * The header reports the chain's cumulative count. Chains written before that
 * column existed report 0, so fall back to the per-run count rather than
 * telling the model zero messages were compacted.
 */
export const applyChatCompactionCheckpoint = ({
  checkpoint,
  messages,
}: ApplyChatCompactionCheckpointProps): ChatMessage[] => {
  const firstKeptIndex = messages.findIndex(
    (message) => message.id === checkpoint.firstKeptMessageId,
  );

  return [
    createCompactionSummaryMessage({
      summarizedMessageCount: Math.max(
        checkpoint.totalSummarizedMessageCount,
        checkpoint.summarizedMessageCount,
      ),
      summary: checkpoint.summaryMarkdown,
    }),
    ...(firstKeptIndex === -1 ? messages : messages.slice(firstKeptIndex)),
  ];
};

type ShouldInvalidateChatCompactionCheckpointProps = {
  deletedMessageCount: number;
  persistencePlan: Pick<MessagePersistencePlan, "type">;
};

export const shouldInvalidateChatCompactionCheckpoint = ({
  deletedMessageCount,
  persistencePlan,
}: ShouldInvalidateChatCompactionCheckpointProps): boolean => {
  if (deletedMessageCount > 0) {
    return true;
  }

  switch (persistencePlan.type) {
    case "update":
    case "replace-last-assistant":
      return true;
    case "insert":
    case "none":
      return false;
    default: {
      persistencePlan.type satisfies never;
      return panic(`Unhandled type: ${String(persistencePlan.type)}`);
    }
  }
};

type InvalidateChatCompactionChainProps = {
  threadId: SafeId<"chatThread">;
  tx: Transaction;
};

/**
 * Invalidate a thread's compaction chain after an edit, replay, or delete.
 *
 * Retires the active checkpoint and bumps the thread's compaction epoch, and
 * does both in one place on purpose. Retiring the checkpoint alone is invisible
 * to a compaction of a thread that has none: nothing is marked stale, so a run
 * in flight would compare `null === null` and accept a summary built from the
 * content this call is invalidating. The epoch is the signal that survives that
 * case, so it must move wherever the checkpoint does.
 */
export const invalidateChatCompactionChain = async ({
  threadId,
  tx,
}: InvalidateChatCompactionChainProps): Promise<void> => {
  // audit: skip - derived compaction checkpoint cache; no user-authored state change
  await tx
    .update(chatThreadCompactions)
    .set({ status: "stale" })
    .where(
      and(
        eq(chatThreadCompactions.threadId, threadId),
        eq(chatThreadCompactions.status, "active"),
      ),
    );

  // Written as a statement so the bump does not drag `chat_threads`'
  // `$onUpdate` columns (the list-ordering stamp and the rollback token) along
  // with it. audit: skip - derived compaction chain marker.
  await tx.execute(
    sql`update ${chatThreads} set compaction_epoch = compaction_epoch + 1 where ${chatThreads.id} = ${threadId}`,
  );
};
