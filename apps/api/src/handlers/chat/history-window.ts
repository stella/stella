import { Result } from "better-result";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError, SafeDbOrTx } from "@/api/db/safe-db";
import { withScopedTx } from "@/api/db/safe-db";
import { chatMessages } from "@/api/db/schema";
import {
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
} from "@/api/handlers/chat/chat-message-parts";
import type { ChatThreadCompactionCheckpoint } from "@/api/handlers/chat/persistent-compaction";
import { readLatestChatCompactionOnTx } from "@/api/handlers/chat/persistent-compaction";
import type {
  ChatMessageContent,
  ChatMessageRole,
  PersistedChatMessageContent,
} from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { chatMessageCursorCodec } from "@/api/lib/chat/message-cursor";
import type { TimestampIdCursor } from "@/api/lib/db-pagination";
import { LIMITS } from "@/api/lib/limits";

export type WindowedThreadMessage = {
  id: SafeId<"chatMessage">;
  role: ChatMessageRole;
  content: ChatMessageContent;
};

/**
 * Normalize a stored row's content (which may be a legacy v1 payload) into the
 * canonical version-2 `ChatMessageContent` the rest of the chat pipeline reads.
 */
const toWindowedMessage = (row: {
  id: SafeId<"chatMessage">;
  role: ChatMessageRole;
  content: PersistedChatMessageContent;
}): WindowedThreadMessage => ({
  id: row.id,
  role: row.role,
  content: chatMessageContentFromMessage(chatMessageFromPersisted(row)),
});

/**
 * Decode a checkpoint's stored delta cursor.
 *
 * Returns null both when there is no checkpoint and when its cursor is absent
 * or unreadable (a chain written before the cursor column landed). Null means
 * "read from the start of the thread", which the row cap keeps bounded and
 * which the compactor repairs by writing a cursor on its next run.
 */
const decodeChatCompactionDeltaCursor = (
  checkpoint: ChatThreadCompactionCheckpoint | null,
): TimestampIdCursor<SafeId<"chatMessage">> | null =>
  checkpoint?.deltaCursor
    ? chatMessageCursorCodec.decode(checkpoint.deltaCursor)
    : null;

type LoadWindowedThreadMessagesOnTxArgs = {
  tx: Transaction;
  threadId: SafeId<"chatThread">;
  /** Upper bound on rows read; defaults to the per-send history window. */
  limit?: number | undefined;
  /** The active checkpoint, when the caller already fetched one (e.g.
   *  alongside this call, in the same transaction) — skips this
   *  function's own `readLatestChatCompactionOnTx` read. Omit to have it
   *  self-fetch, as every existing caller does. */
  checkpoint?: ChatThreadCompactionCheckpoint | null | undefined;
};

/**
 * Load the per-send message window for a thread, ascending (oldest-first).
 *
 * One shape, always bounded: the newest `limit` messages recorded after the
 * active checkpoint's cursor (the whole thread, when it has no checkpoint).
 * The cursor comparison happens in-database at full microsecond precision, so
 * a message sharing a millisecond with the boundary is neither skipped nor
 * re-admitted.
 *
 * Everything at or before the cursor is already represented by the stored
 * summary, which `applyChatCompactionCheckpoint` prepends, so the window never
 * needs to reach behind it. Should the post-checkpoint tail itself exceed
 * `limit` — a thread sending faster than the compactor drains it — the oldest
 * rows of that tail are dropped from this window. The compactor summarizes
 * them on its next run and advances the cursor past them, so the loss is
 * transient and the read stays bounded either way.
 */
const loadWindowedThreadMessagesOnTx = async ({
  tx,
  threadId,
  limit = LIMITS.chatSendHistoryWindowMax,
  checkpoint,
}: LoadWindowedThreadMessagesOnTxArgs): Promise<WindowedThreadMessage[]> => {
  const resolvedCheckpoint =
    checkpoint === undefined
      ? await readLatestChatCompactionOnTx({ threadId, tx })
      : checkpoint;
  const cursor = decodeChatCompactionDeltaCursor(resolvedCheckpoint);

  const rows = await tx
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, threadId),
        // Newest-first with a row cap, so the predicate selects everything
        // after the checkpoint and the LIMIT keeps the most recent slice of
        // it. `ascending` here names the cursor comparison (rows greater than
        // the boundary), not the row order the caller receives.
        cursor === null
          ? undefined
          : chatMessageCursorCodec.keysetAfter({
              cursor,
              idColumn: chatMessages.id,
              direction: "ascending",
            }),
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(limit);

  return rows.toReversed().map(toWindowedMessage);
};

type LoadWindowedThreadMessagesArgs = SafeDbOrTx &
  Omit<LoadWindowedThreadMessagesOnTxArgs, "tx">;

export const loadWindowedThreadMessages = async ({
  threadId,
  limit,
  checkpoint,
  ...handle
}: LoadWindowedThreadMessagesArgs): Promise<
  Result<WindowedThreadMessage[], SafeDbError>
> =>
  await withScopedTx(
    handle,
    async (tx) =>
      await loadWindowedThreadMessagesOnTx({
        tx,
        threadId,
        limit,
        checkpoint,
      }),
  );

type ResolveTruncationTargetArgs = {
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  targetMessageId: SafeId<"chatMessage">;
};

export type TruncationTarget = {
  /** Retained prefix (rows at or before the target), ascending. */
  messagesForPersistence: WindowedThreadMessage[];
  /** Rows strictly after the target — deleted on replay. */
  deleteMessageIdsBeforeLatest: SafeId<"chatMessage">[];
  /** Whether replaying this target would discard a newer user turn. */
  hasLaterUserMessage: boolean;
};

/**
 * Resolve a truncation target by id against the full thread history, not the
 * (windowed) in-memory list, so an edit/replay target older than the window
 * stays findable. Returns the retained prefix (needed to recompute the thread
 * data scope) and the set of ids strictly newer than the target (deleted on
 * replay). Returns null when the target id does not belong to this thread.
 */
export const resolveTruncationTarget = async ({
  safeDb,
  threadId,
  targetMessageId,
}: ResolveTruncationTargetArgs): Promise<
  Result<TruncationTarget | null, SafeDbError>
> =>
  await Result.gen(async function* () {
    const target = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ id: chatMessages.id })
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.threadId, threadId),
              eq(chatMessages.id, targetMessageId),
            ),
          )
          .limit(1),
      ),
    );
    if (!target.at(0)) {
      return Result.ok(null);
    }

    const retainedPrefix = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: chatMessages.id,
            role: chatMessages.role,
            content: chatMessages.content,
          })
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.threadId, threadId),
              // Resolve the (createdAt, id) boundary in-DB by id, NOT via a
              // JS-Date-truncated value: a target whose created_at carries
              // Postgres microseconds would otherwise fall before the truncated
              // boundary and be dropped from the retained prefix (then deleted),
              // making the edited message vanish.
              sql`(${chatMessages.createdAt}, ${chatMessages.id}) <= (select b.created_at, b.id from chat_messages b where b.id = ${targetMessageId})`,
            ),
          )
          // SAFETY: bounded by the retained prefix [start..target]; the target is
          // a real row in this thread (resolved above), and a replay only retains
          // messages up to it.
          // eslint-disable-next-line require-query-limit/require-query-limit -- bounded by the retained replay prefix up to the target row; see SAFETY above
          .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id)),
      ),
    );

    const idsAfterTarget = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ id: chatMessages.id, role: chatMessages.role })
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.threadId, threadId),
              // Same in-DB boundary, strictly greater, so the target row is kept
              // (only newer rows are replayed away).
              sql`(${chatMessages.createdAt}, ${chatMessages.id}) > (select b.created_at, b.id from chat_messages b where b.id = ${targetMessageId})`,
            ),
          )
          // SAFETY: bounded by the to-be-deleted tail (target..now]; the rows a
          // replay discards after the target, which the caller deletes.
          // eslint-disable-next-line require-query-limit/require-query-limit -- bounded by the replayed-away tail after the target row; see SAFETY above
          .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id)),
      ),
    );

    return Result.ok({
      messagesForPersistence: retainedPrefix.map(toWindowedMessage),
      deleteMessageIdsBeforeLatest: idsAfterTarget.map((row) => row.id),
      hasLaterUserMessage: idsAfterTarget.some((row) => row.role === "user"),
    });
  });

type ChatMessageExistsForThreadArgs = {
  messageId: SafeId<"chatMessage">;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
};

/**
 * Targeted existence check for the incoming message id, used so a windowed
 * load (which may exclude an old re-sent id) cannot drive a duplicate insert.
 */
export const chatMessageExistsForThread = async ({
  messageId,
  safeDb,
  threadId,
}: ChatMessageExistsForThreadArgs): Promise<Result<boolean, SafeDbError>> =>
  await Result.gen(async function* () {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ id: chatMessages.id })
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.threadId, threadId),
              eq(chatMessages.id, messageId),
            ),
          )
          .limit(1),
      ),
    );
    return Result.ok(rows.length > 0);
  });
