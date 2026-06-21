import { Result } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db";
import { chatMessages } from "@/api/db/schema";
import { normalizeLegacyToolInputs } from "@/api/handlers/chat/legacy-tool-compat";
import { readLatestChatCompaction } from "@/api/handlers/chat/persistent-compaction";
import type {
  ChatMessage,
  ChatMessageContent,
  ChatMessageRole,
} from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";

export type WindowedThreadMessage = {
  id: SafeId<"chatMessage">;
  role: ChatMessageRole;
  content: ChatMessageContent;
};

type LoadWindowedThreadMessagesArgs = {
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
};

/**
 * Load the per-send message window for a thread, ascending (oldest-first).
 *
 * When an active compaction checkpoint exists, only rows at or after its
 * `firstKeptMessageId` are read; everything before that boundary is already
 * captured in the checkpoint summary, so the per-send read drops the
 * already-summarized prefix. The boundary is resolved in-DB against the
 * checkpoint row's full-precision (createdAt, id) tuple — mirroring the keyset
 * pattern in message-page.ts — so rows that share a millisecond with
 * `firstKeptMessageId` are never skipped. When no checkpoint exists, all rows
 * are read.
 */
export const loadWindowedThreadMessages = async ({
  safeDb,
  threadId,
}: LoadWindowedThreadMessagesArgs): Promise<
  Result<WindowedThreadMessage[], SafeDbError>
> =>
  await Result.gen(async function* () {
    const checkpoint = yield* Result.await(
      readLatestChatCompaction({ safeDb, threadId }),
    );
    const firstKeptMessageId = checkpoint?.firstKeptMessageId ?? null;

    const rows = yield* Result.await(
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
              // Mirrors message-page.ts: compare the full-precision
              // (createdAt, id) tuple in-DB against the boundary row (looked up
              // by id) so same-millisecond rows are not skipped.
              firstKeptMessageId
                ? sql`(${chatMessages.createdAt}, ${chatMessages.id}) >= (select b.created_at, b.id from chat_messages b where b.id = ${firstKeptMessageId})`
                : undefined,
            ),
          )
          // SAFETY: token-bounded. With an active checkpoint this reads only the
          // preserve window [firstKept..now]; a new checkpoint forms once that
          // window crosses the compaction trigger, so it cannot grow unbounded.
          // With no checkpoint the thread is necessarily below the trigger (the
          // first checkpoint would have formed otherwise), so the full read is
          // bounded too.
          // eslint-disable-next-line require-query-limit/require-query-limit -- bounded by the compaction preserve window / sub-trigger thread size; see SAFETY above
          .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id)),
      ),
    );

    return Result.ok(rows);
  });

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
        parts: normalizeLegacyToolInputs(row.content.data),
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
          .select({
            id: chatMessages.id,
            createdAt: chatMessages.createdAt,
          })
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
    const targetRow = target.at(0);
    if (!targetRow) {
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
              // Same (createdAt, id) tuple discipline as message-page.ts so the
              // target row itself is included in the retained prefix.
              sql`(${chatMessages.createdAt}, ${chatMessages.id}) <= (${targetRow.createdAt}, ${targetRow.id})`,
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
              // Same tuple boundary as above, strictly greater so the target row
              // is kept (only newer rows are replayed away).
              sql`(${chatMessages.createdAt}, ${chatMessages.id}) > (${targetRow.createdAt}, ${targetRow.id})`,
            ),
          )
          // SAFETY: bounded by the to-be-deleted tail (target..now]; the rows a
          // replay discards after the target, which the caller deletes.
          // eslint-disable-next-line require-query-limit/require-query-limit -- bounded by the replayed-away tail after the target row; see SAFETY above
          .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id)),
      ),
    );

    return Result.ok({
      messagesForPersistence: retainedPrefix,
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
