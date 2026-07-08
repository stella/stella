import { Result } from "better-result";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { SafeDb, SafeDbError, SafeDbOrTx, Transaction } from "@/api/db";
import { withScopedTx } from "@/api/db";
import { chatMessages } from "@/api/db/schema";
import {
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
  normalizePersistedChatMessageContent,
} from "@/api/handlers/chat/chat-message-parts";
import type { ChatThreadCompactionCheckpoint } from "@/api/handlers/chat/persistent-compaction";
import { readLatestChatCompactionOnTx } from "@/api/handlers/chat/persistent-compaction";
import type {
  ChatMessage,
  ChatMessageContent,
  ChatMessageRole,
  PersistedChatMessageContent,
} from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
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

type LoadWindowedThreadMessagesOnTxArgs = {
  tx: Transaction;
  threadId: SafeId<"chatThread">;
  /** Anonymized sends never form a checkpoint, so their no-checkpoint read is
   *  hard-capped; a non-anonymized send loads the full pre-checkpoint history so
   *  compaction can summarize the older prefix into the prompt. */
  isAnonymized: boolean;
  /** Upper bound on rows read in the capped (anonymized) case; defaults to the
   *  per-send history window. */
  limit?: number;
  /** The active checkpoint, when the caller already fetched one (e.g.
   *  alongside this call, in the same transaction) — skips this
   *  function's own `readLatestChatCompactionOnTx` read. Omit to have it
   *  self-fetch, as every existing caller does. */
  checkpoint?: ChatThreadCompactionCheckpoint | null;
};

/**
 * Load the per-send message window for a thread, ascending (oldest-first).
 *
 * Two cases, each bounded differently:
 *
 *  - Active checkpoint: load the full preserve window — rows at or after
 *    `firstKeptMessageId` — with NO row cap. That window is token-bounded by
 *    the compaction cycle (a new checkpoint forms once [firstKept..now] crosses
 *    the trigger), and it must always include `firstKeptMessageId` so
 *    applyChatCompactionCheckpoint can anchor the stored summary; a row cap
 *    could drop the boundary on a long run of short post-checkpoint messages
 *    and silently lose all earlier summarized context. The boundary is resolved
 *    in-DB against the checkpoint row's full-precision (createdAt, id) tuple —
 *    mirroring message-page.ts — so same-millisecond rows are not skipped.
 *
 *  - No checkpoint, non-anonymized: load the FULL pre-checkpoint history (no row
 *    cap). It is token-bounded by the compaction trigger — once crossed, a
 *    checkpoint forms and the branch above takes over — and reading it in full
 *    lets compactChatMessagesForModel summarize the older prefix into the prompt.
 *    Capping here would drop that prefix from both the prompt and the (async,
 *    post-response) checkpoint on the send that first exceeds the window.
 *
 *  - No checkpoint, anonymized (these threads skip checkpoint scheduling, so they
 *    never form one): hard-cap at the most recent `limit` rows so the per-send
 *    read stays bounded. Older rows are dropped — an accepted limit of the
 *    anonymized path, which cannot build a durable summary.
 */
const loadWindowedThreadMessagesOnTx = async ({
  tx,
  threadId,
  isAnonymized,
  limit = LIMITS.chatSendHistoryWindowMax,
  checkpoint,
}: LoadWindowedThreadMessagesOnTxArgs): Promise<WindowedThreadMessage[]> => {
  const resolvedCheckpoint =
    checkpoint === undefined
      ? await readLatestChatCompactionOnTx({ threadId, tx })
      : checkpoint;
  const firstKeptMessageId = resolvedCheckpoint?.firstKeptMessageId ?? null;

  if (firstKeptMessageId) {
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
          sql`(${chatMessages.createdAt}, ${chatMessages.id}) >= (select b.created_at, b.id from chat_messages b where b.id = ${firstKeptMessageId})`,
        ),
      )
      // SAFETY: token-bounded by the compaction preserve window; a new
      // checkpoint forms once [firstKept..now] crosses the trigger, so it
      // cannot grow unbounded. Intentionally NOT row-capped: firstKept
      // must remain in the result for the stored summary to anchor.
      // eslint-disable-next-line require-query-limit/require-query-limit -- token-bounded preserve window; see SAFETY above
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
    return rows.map(toWindowedMessage);
  }

  if (!isAnonymized) {
    // No checkpoint yet, but a non-anonymized thread forms one once its
    // history crosses the compaction trigger, so read the full pre-checkpoint
    // history and let compactChatMessagesForModel summarize the older prefix
    // into the prompt. Capping here would drop that prefix from the prompt on
    // the send that first exceeds the window (the checkpoint is written only
    // afterwards, off the hot path).
    const fullRows = await tx
      .select({
        id: chatMessages.id,
        role: chatMessages.role,
        content: chatMessages.content,
      })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
      // SAFETY: token-bounded by the compaction trigger — a checkpoint
      // forms once the history crosses it, after which the preserve-window
      // branch above bounds the read. Only un-checkpointed non-anonymized
      // threads (always under the trigger) read in full here.
      // eslint-disable-next-line require-query-limit/require-query-limit -- token-bounded pre-checkpoint history; see SAFETY above
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
    return fullRows.map(toWindowedMessage);
  }

  // Anonymized thread: it never forms a checkpoint, so hard-cap the read at
  // the most recent `limit` rows (reversed to ascending below).
  const rows = await tx
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
    })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(limit);

  return rows.toReversed().map(toWindowedMessage);
};

type LoadWindowedThreadMessagesArgs = SafeDbOrTx &
  Omit<LoadWindowedThreadMessagesOnTxArgs, "tx">;

export const loadWindowedThreadMessages = async ({
  threadId,
  isAnonymized,
  limit,
  checkpoint,
  ...handle
}: LoadWindowedThreadMessagesArgs): Promise<
  Result<WindowedThreadMessage[], SafeDbError>
> =>
  await withScopedTx(handle, (tx) =>
    loadWindowedThreadMessagesOnTx({
      tx,
      threadId,
      isAnonymized,
      limit,
      checkpoint,
    }),
  );

type LoadFullThreadHistoryArgs = {
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
};

/**
 * Load the entire thread history, ascending, as `ChatMessage[]`. This is the
 * one place that deliberately reads the unsummarized prefix: the compaction
 * checkpoint writer needs the true start of the conversation to build a
 * durable summary with real boundary message ids. It runs off the request hot
 * path and only when the window has crossed the compaction trigger, so it
 * never gates a normal send.
 */
export const loadFullThreadHistory = async ({
  safeDb,
  threadId,
}: LoadFullThreadHistoryArgs): Promise<Result<ChatMessage[], SafeDbError>> =>
  await Result.gen(async function* () {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: chatMessages.id,
            role: chatMessages.role,
            content: chatMessages.content,
          })
          .from(chatMessages)
          .where(eq(chatMessages.threadId, threadId))
          // SAFETY: full unsummarized history is structurally required to build a
          // correct compaction checkpoint with real boundary message ids. Off the
          // request hot path; only invoked when the per-send window has crossed
          // the compaction trigger (a rare event), never on a normal send.
          // eslint-disable-next-line require-query-limit/require-query-limit -- compaction-only full read; runs off the hot path when the window crosses the trigger; see SAFETY above
          .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id)),
      ),
    );

    return Result.ok(
      rows.map((row) => ({
        id: row.id,
        role: row.role,
        parts: normalizePersistedChatMessageContent(row.content).parts,
      })),
    );
  });

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
          .select({ id: chatMessages.id })
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
