import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import { CHAT_THREAD_NOT_FOUND_ERROR_CODE } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import { chatThreads, chatTurns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { ChatTurnStatus } from "@/api/lib/chat/turn-status";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

// A chat's per-reader states (read or unread, pinned or not), as the chats
// list derives them and as the reader's own writes change them.

/** Turn statuses that leave an answer for the reader to read. */
const ANSWERED_TURN_STATUSES = [
  "completed",
  "failed",
] as const satisfies readonly ChatTurnStatus[];

/**
 * The thread's latest answer, by one backward step through
 * chat_turns_org_user_thread_created_idx per row; a later turn stopped or
 * interrupted before answering leaves it in place. Correlated with the
 * chat_threads row of the statement it is used in.
 */
const latestAnswer = new QueryBuilder()
  .select({ settledAt: chatTurns.settledAt })
  .from(chatTurns)
  .where(
    and(
      eq(chatTurns.organizationId, chatThreads.organizationId),
      eq(chatTurns.userId, chatThreads.userId),
      eq(chatTurns.threadId, chatThreads.id),
      sql`${chatTurns.status} IN (${sql.join(
        ANSWERED_TURN_STATUSES.map((status) => sql`${status}`),
        sql`, `,
      )})`,
    ),
  )
  .orderBy(desc(chatTurns.createdAt), desc(chatTurns.id))
  .limit(1);

/** The latest answer as a lateral join, for a read over many threads. */
export const LATEST_ANSWER = latestAnswer.as("latest_answer");

/**
 * Whether the reader has an answer to read; null last_read_at is an explicit
 * "mark unread". Both sides are columns compared in the database at their
 * stored precision. The one rule for the list's readState and for the
 * read-state write's condition, so the two cannot disagree.
 */
const unreadGiven = (latestAnswerSettledAt: SQLWrapper) =>
  sql<boolean>`coalesce(${chatThreads.lastReadAt} IS NULL OR ${latestAnswerSettledAt}::timestamptz > ${chatThreads.lastReadAt}::timestamptz, false)`;

/** Unread, in a query that lateral-joins {@link LATEST_ANSWER}. */
export const UNREAD_BESIDE_LATEST_ANSWER = unreadGiven(LATEST_ANSWER.settledAt);

/** Unread, in a statement over chat_threads alone (an update's condition). */
export const UNREAD = unreadGiven(latestAnswer);

type ReaderThread = {
  organizationId: string;
  scope: { scope: "global" } | { scope: "workspace"; workspaceId: string };
  threadId: SafeId<"chatThread">;
  userId: string;
};

/** The reader's own thread, in the scope the request named. */
export const readerThreadPredicate = ({
  organizationId,
  scope,
  threadId,
  userId,
}: ReaderThread): SQL =>
  and(
    eq(chatThreads.id, threadId),
    eq(chatThreads.organizationId, organizationId),
    eq(chatThreads.userId, userId),
    scope.scope === "workspace"
      ? eq(chatThreads.workspaceId, scope.workspaceId)
      : isNull(chatThreads.workspaceId),
  ) ?? sql`false`;

/**
 * What a reader-state write did. `unchanged` is the thread already in the
 * requested state: the request succeeds, writes nothing and tells no device.
 */
export type ReaderStateWrite = "changed" | "missing" | "unchanged";

/**
 * Run a reader-state transition that is conditional on the state it replaces,
 * so a request that changes nothing matches no row, and concurrent writers
 * each see the state the one before them left. Only when it changed no row
 * does the same transaction ask whether the thread exists in that scope at
 * all, which tells an already-held state from a thread that is not there.
 */
export const writeReaderState = async ({
  thread,
  transition,
  tx,
}: {
  thread: SQL;
  transition: () => Promise<readonly unknown[]>;
  tx: Transaction;
}): Promise<ReaderStateWrite> => {
  const changed = await transition();
  if (changed.length > 0) {
    return "changed";
  }
  const [existing] = await tx
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(thread)
    .limit(1);
  return existing === undefined ? "missing" : "unchanged";
};

export const readerThreadNotFoundError = () =>
  new HandlerError({
    status: 404,
    code: CHAT_THREAD_NOT_FOUND_ERROR_CODE,
    message: "Chat thread not found",
    hint: "List your chats with chat.threads.list and pass a matter chat's matterId with it.",
  });
