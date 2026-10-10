import { panic } from "better-result";
import type { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDbError, SafeDbOrTx } from "@/api/db/safe-db";
import { withScopedTx } from "@/api/db/safe-db";
import {
  chatMessages,
  chatThreadCompactions,
  chatThreads,
} from "@/api/db/schema";
import { createCompactionSummaryMessage } from "@/api/handlers/chat/compaction";
import type { MessagePersistencePlan } from "@/api/handlers/chat/persist-message";
import type {
  ChatCompactionSummary,
  ChatMessage,
} from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { chatMessageCursorCodec } from "@/api/lib/chat/message-cursor";
import type { TimestampIdCursor } from "@/api/lib/db-pagination";

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

/**
 * Decode a checkpoint's stored delta cursor.
 *
 * Returns null both when there is no checkpoint and when its cursor is absent
 * or unreadable (a chain written before the cursor column landed). Null means
 * "read from the start of the thread", which the row cap keeps bounded and
 * which the compactor repairs by writing a cursor on its next run.
 */
export const decodeChatCompactionDeltaCursor = (
  checkpoint: ChatThreadCompactionCheckpoint | null,
): TimestampIdCursor<SafeId<"chatMessage">> | null =>
  checkpoint?.deltaCursor
    ? chatMessageCursorCodec.decode(checkpoint.deltaCursor)
    : null;

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

type InvalidateChatCompactionChainProps = {
  threadId: SafeId<"chatThread">;
  tx: Transaction;
};

/**
 * Move the thread's compaction epoch, so a summary in flight that read rows a
 * write changes is refused when it tries to install itself.
 *
 * Written as a statement so the bump does not drag `chat_threads`'
 * `$onUpdate` columns (the list-ordering stamp and the rollback token) along
 * with it. Its row lock is the one the compactor's advance takes, so the two
 * serialize on the thread.
 */
const advanceChatCompactionEpochOnTx = async ({
  threadId,
  tx,
}: InvalidateChatCompactionChainProps): Promise<void> => {
  // audit: skip - derived compaction chain marker
  await tx.execute(
    sql`update ${chatThreads} set compaction_epoch = compaction_epoch + 1 where ${chatThreads.id} = ${threadId}`,
  );
};

const retireActiveChatCompactionOnTx = async ({
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
  await retireActiveChatCompactionOnTx({ threadId, tx });
  await advanceChatCompactionEpochOnTx({ threadId, tx });
};

type IsKeptByChatCompactionOnTxProps = {
  checkpoint: ChatThreadCompactionCheckpoint;
  messageId: SafeId<"chatMessage">;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
};

/**
 * Whether a message of the thread lies after the checkpoint's cursor, outside
 * everything its summary represents. A chain without a readable cursor has no
 * boundary to prove that against, so none of its rows count as kept.
 */
const isKeptByChatCompactionOnTx = async ({
  checkpoint,
  messageId,
  threadId,
  tx,
}: IsKeptByChatCompactionOnTxProps): Promise<boolean> => {
  const cursor = decodeChatCompactionDeltaCursor(checkpoint);
  const afterCursor =
    cursor === null
      ? undefined
      : chatMessageCursorCodec.keysetAfter({
          cursor,
          direction: "ascending",
          idColumn: chatMessages.id,
        });
  if (afterCursor === undefined) {
    return false;
  }
  const kept = await tx
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, threadId),
        eq(chatMessages.id, messageId),
        afterCursor,
      ),
    )
    .limit(1);
  return kept.length === 1;
};

type ReconcileChatCompactionChainOnTxProps = {
  /** The rows the write deletes. */
  deletedMessageIds: readonly SafeId<"chatMessage">[];
  persistencePlan:
    | Exclude<MessagePersistencePlan, { type: "update" }>
    | Pick<
        Extract<MessagePersistencePlan, { type: "update" }>,
        "type" | "messageId"
      >;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
};

/**
 * Keep a thread's compaction chain true to one history write, on the write's
 * transaction.
 *
 * An append leaves the chain alone. Every other write moves the epoch, so no
 * summary built from the rows it changes can land. The active checkpoint is
 * retired only when the write reaches history the summary represents: a
 * deletion, which can cross the boundary or remove the row the checkpoint is
 * anchored on, or a rewrite of a row at or before the cursor. Rewriting a row
 * after the cursor, as a continuation does when it stores its owning
 * assistant message, leaves the summary true, so the turn it resumes and
 * every later turn still read it.
 */
export const reconcileChatCompactionChainOnTx = async ({
  deletedMessageIds,
  persistencePlan,
  threadId,
  tx,
}: ReconcileChatCompactionChainOnTxProps): Promise<void> => {
  if (deletedMessageIds.length > 0) {
    await invalidateChatCompactionChain({ threadId, tx });
    return;
  }

  switch (persistencePlan.type) {
    case "insert":
    case "none":
      return;
    case "replace-last-assistant":
      await invalidateChatCompactionChain({ threadId, tx });
      return;
    case "update": {
      // Epoch first: its row lock orders the checkpoint read after any advance
      // that committed, and any later advance after this write.
      await advanceChatCompactionEpochOnTx({ threadId, tx });
      const checkpoint = await readLatestChatCompactionOnTx({ threadId, tx });
      if (
        checkpoint === null ||
        (await isKeptByChatCompactionOnTx({
          checkpoint,
          messageId: persistencePlan.messageId,
          threadId,
          tx,
        }))
      ) {
        return;
      }
      await retireActiveChatCompactionOnTx({ threadId, tx });
      return;
    }
    default:
      persistencePlan satisfies never;
      return panic(
        `Unhandled persistence plan: ${JSON.stringify(persistencePlan)}`,
      );
  }
};
