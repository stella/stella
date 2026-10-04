import { panic, Result } from "better-result";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError, SafeDbOrTx } from "@/api/db/safe-db";
import { withScopedTx } from "@/api/db/safe-db";
import { chatMessages } from "@/api/db/schema";
import {
  chatMessageFromPersisted,
  toChatMessageContent,
} from "@/api/handlers/chat/chat-message-parts";
import type { ChatThreadCompactionCheckpoint } from "@/api/handlers/chat/persistent-compaction";
import {
  decodeChatCompactionDeltaCursor,
  readLatestChatCompactionOnTx,
} from "@/api/handlers/chat/persistent-compaction";
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
}): WindowedThreadMessage => {
  const message = chatMessageFromPersisted(row);
  return {
    id: row.id,
    role: row.role,
    content: toChatMessageContent({
      data: message.parts,
      ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
      version: 2,
    }),
  };
};

/**
 * PostgreSQL's version of the row: every insert and every update writes a new
 * one, so two reads that agree on it read the same content.
 */
const chatMessageRowVersion = sql<string>`${chatMessages}.xmin::text`;

/** The range of a thread's rows one history read covered. */
type ChatHistoryScope =
  | { type: "thread" }
  | {
      cursor: TimestampIdCursor<SafeId<"chatMessage">>;
      type: "after-cursor";
    }
  | { messageId: SafeId<"chatMessage">; type: "from-message" };

/**
 * The rows a decision about a thread's history read, oldest-first, each with
 * the version it read. A turn accepted on that decision must find them
 * unchanged under the thread's turn lock (`isChatHistorySnapshotCurrentOnTx`):
 * a turn that settled in between would otherwise be missing from the model's
 * history, or be deleted by a replay that no longer targets the latest turn.
 */
export type ChatHistorySnapshot = {
  rows: readonly { id: SafeId<"chatMessage">; version: string }[];
  scope: ChatHistoryScope;
};

type WindowedThreadHistory = {
  messages: WindowedThreadMessage[];
  snapshot: ChatHistorySnapshot;
};

/** The history of a thread with no messages, as its creator knows it. */
export const EMPTY_CHAT_HISTORY_SNAPSHOT: ChatHistorySnapshot = {
  rows: [],
  scope: { type: "thread" },
};

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
const loadWindowedThreadHistoryOnTx = async ({
  tx,
  threadId,
  limit = LIMITS.chatSendHistoryWindowMax,
  checkpoint,
}: LoadWindowedThreadMessagesOnTxArgs): Promise<WindowedThreadHistory> => {
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
      version: chatMessageRowVersion,
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

  const ascending = rows.toReversed();
  return {
    messages: ascending.map(toWindowedMessage),
    snapshot: {
      rows: ascending.map(({ id, version }) => ({ id, version })),
      scope: windowScope({ ascending, cursor, limit }),
    },
  };
};

/**
 * Where a window's rows begin: at its oldest row when the row cap cut it,
 * otherwise after the checkpoint cursor it was read from, or at the start of
 * the thread.
 */
const windowScope = ({
  ascending,
  cursor,
  limit,
}: {
  ascending: readonly { id: SafeId<"chatMessage"> }[];
  cursor: TimestampIdCursor<SafeId<"chatMessage">> | null;
  limit: number;
}): ChatHistoryScope => {
  const oldest = ascending.at(0);
  if (oldest !== undefined && ascending.length === limit) {
    return { messageId: oldest.id, type: "from-message" };
  }
  return cursor === null
    ? { type: "thread" }
    : { cursor, type: "after-cursor" };
};

type LoadWindowedThreadMessagesArgs = SafeDbOrTx &
  Omit<LoadWindowedThreadMessagesOnTxArgs, "tx">;

/** The per-send window with the snapshot a decision made from it holds. */
export const loadWindowedThreadHistory = async ({
  threadId,
  limit,
  checkpoint,
  ...handle
}: LoadWindowedThreadMessagesArgs): Promise<
  Result<WindowedThreadHistory, SafeDbError>
> =>
  await withScopedTx(
    handle,
    async (tx) =>
      await loadWindowedThreadHistoryOnTx({
        tx,
        threadId,
        limit,
        checkpoint,
      }),
  );

export const loadWindowedThreadMessages = async (
  args: LoadWindowedThreadMessagesArgs,
): Promise<Result<WindowedThreadMessage[], SafeDbError>> =>
  (await loadWindowedThreadHistory(args)).map(({ messages }) => messages);

/**
 * Whether the rows a history decision read are still exactly the thread's
 * rows in that read's range: none added, removed, or rewritten. A caller that
 * holds the thread's turn lock gets an answer no later write can change until
 * it commits.
 */
export const isChatHistorySnapshotCurrentOnTx = async ({
  snapshot,
  threadId,
  tx,
}: {
  snapshot: ChatHistorySnapshot;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<boolean> => {
  const current = await tx
    .select({ id: chatMessages.id, version: chatMessageRowVersion })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, threadId),
        chatHistoryScopePredicate({ scope: snapshot.scope, threadId }),
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
    // One row past the snapshot is enough to see that the range grew.
    .limit(snapshot.rows.length + 1);
  return (
    current.length === snapshot.rows.length &&
    current.every(({ id, version }, index) => {
      const read = snapshot.rows.at(index);
      return read?.id === id && read.version === version;
    })
  );
};

const BOUNDARY_COMPARISON = {
  after: ">",
  "at-or-after": ">=",
  "at-or-before": "<=",
} as const;

/**
 * `(created_at, id)` keyset boundary for the prefix ending at one message,
 * resolved in-database from the target row.
 *
 * The boundary is NOT built from a JS-Date-truncated value: a target whose
 * `created_at` carries PostgreSQL microseconds would fall before a truncated
 * boundary and drop out of its own prefix. `at-or-before` keeps the target
 * row (retained prefix, forked history); `after` selects only the tail a
 * replay discards; `at-or-after` is a window that starts at the target.
 *
 * The subselect binds the boundary row to the thread being read: a target
 * that belongs to another thread, or that was deleted since the caller last
 * saw it, resolves to a NULL boundary that matches no row, never to another
 * thread's timestamp.
 */
const chatMessagePrefixBoundary = ({
  side,
  targetMessageId,
  threadId,
}: {
  side: keyof typeof BOUNDARY_COMPARISON;
  targetMessageId: SafeId<"chatMessage">;
  threadId: SafeId<"chatThread">;
}): SQL =>
  sql`(${chatMessages.createdAt}, ${chatMessages.id}) ${sql.raw(BOUNDARY_COMPARISON[side])} (select b.created_at, b.id from chat_messages b where b.id = ${targetMessageId} and b.thread_id = ${threadId})`;

/** The rows a history snapshot covers, as the read that took it bounded them. */
const chatHistoryScopePredicate = ({
  scope,
  threadId,
}: {
  scope: ChatHistoryScope;
  threadId: SafeId<"chatThread">;
}): SQL | undefined => {
  switch (scope.type) {
    case "thread":
      return undefined;
    case "after-cursor":
      return chatMessageCursorCodec.keysetAfter({
        cursor: scope.cursor,
        direction: "ascending",
        idColumn: chatMessages.id,
      });
    case "from-message":
      return chatMessagePrefixBoundary({
        side: "at-or-after",
        targetMessageId: scope.messageId,
        threadId,
      });
    default:
      scope satisfies never;
      return panic(`Unhandled history scope: ${JSON.stringify(scope)}`);
  }
};

type LoadChatMessagePrefixOnTxArgs = {
  targetMessageId: SafeId<"chatMessage">;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
};

export type ChatMessagePrefixRow = {
  content: PersistedChatMessageContent;
  createdAt: Date;
  id: SafeId<"chatMessage">;
  memoryExtractionEligible: boolean;
  role: ChatMessageRole;
  /** See `chatMessageRowVersion`. */
  version: string;
  workspaceId: SafeId<"workspace"> | null;
};

/**
 * Every row of a thread at or before one of its messages, oldest-first, with
 * the columns a copy of that history needs. Returns null when the target is
 * not a message of this thread.
 *
 * One statement, not an existence check followed by the read: under READ
 * COMMITTED a target deleted between two statements would turn into an
 * empty prefix that reads as success. An inclusive prefix always contains
 * its own boundary row, so an empty read can only mean the boundary has no
 * row in this thread.
 */
export const loadChatMessagePrefixOnTx = async ({
  targetMessageId,
  threadId,
  tx,
}: LoadChatMessagePrefixOnTxArgs): Promise<ChatMessagePrefixRow[] | null> => {
  const prefix = await tx
    .select({
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
      id: chatMessages.id,
      memoryExtractionEligible: chatMessages.memoryExtractionEligible,
      role: chatMessages.role,
      version: chatMessageRowVersion,
      workspaceId: chatMessages.workspaceId,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, threadId),
        chatMessagePrefixBoundary({
          side: "at-or-before",
          targetMessageId,
          threadId,
        }),
      ),
    )
    // SAFETY: one thread's rows at or before one of its messages. A fork
    // copies all of them, so a page limit would silently truncate the
    // forked history; there is no smaller correct result.
    // oxlint-disable-next-line require-query-limit/require-query-limit -- a fork copies every row up to the target, so a limit would truncate it; see SAFETY above
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
  return prefix.length === 0 ? null : prefix;
};

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
  /** The whole thread as this resolution read it. */
  snapshot: ChatHistorySnapshot;
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
  // One scoped transaction for both halves of the split, so the retained
  // prefix and the discarded tail cannot observe different thread states.
  await safeDb(async (tx) => {
    const retainedPrefix = await loadChatMessagePrefixOnTx({
      targetMessageId,
      threadId,
      tx,
    });
    if (retainedPrefix === null) {
      return null;
    }

    const idsAfterTarget = await tx
      .select({
        id: chatMessages.id,
        role: chatMessages.role,
        version: chatMessageRowVersion,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.threadId, threadId),
          chatMessagePrefixBoundary({
            side: "after",
            targetMessageId,
            threadId,
          }),
        ),
      )
      // SAFETY: ids only, of one thread's rows after one of its messages. A
      // replay deletes every one of them, so a page limit would leave later
      // turns behind; there is no smaller correct result.
      // oxlint-disable-next-line require-query-limit/require-query-limit -- a replay deletes every row after the target, so a limit would leave some behind; see SAFETY above
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));

    return {
      messagesForPersistence: retainedPrefix.map(toWindowedMessage),
      deleteMessageIdsBeforeLatest: idsAfterTarget.map((row) => row.id),
      hasLaterUserMessage: idsAfterTarget.some((row) => row.role === "user"),
      // Exactly the rows every decision above came from, so whenever the
      // snapshot still matches the thread, so do they.
      snapshot: {
        rows: [...retainedPrefix, ...idsAfterTarget].map(({ id, version }) => ({
          id,
          version,
        })),
        scope: { type: "thread" },
      },
    };
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
