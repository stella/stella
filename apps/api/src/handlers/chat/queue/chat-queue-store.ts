import { panic } from "better-result";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";

import {
  CHAT_QUEUE_LIMIT,
  CHAT_QUEUE_PREVIEW_MAX_CHARS,
  type ChatQueueHoldReason,
} from "@stll/api-contract/chat-queue";

import type { Transaction } from "@/api/db/root";
import {
  chatQueuedMessages,
  chatQueueHolds,
  chatThreads,
} from "@/api/db/schema";
import {
  getChatAttachmentUrl,
  isChatAttachmentPart,
} from "@/api/handlers/chat/chat-message-parts";
import {
  type QueuedChatSend,
  queuedChatSendSchema,
} from "@/api/handlers/chat/chat-schema";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { wasSentOnTx } from "@/api/lib/db/chat-queue-gate";
import { type BoundedReadResult, readBounded } from "@/api/lib/db/read-bounded";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";
import { isRecord } from "@/api/lib/type-guards";
import { isUserFileUrl } from "@/api/lib/user-files/types";

/** One queued message as the queue shows it; its body stays on the server. */
export type ChatQueueItem = {
  id: SafeId<"chatMessage">;
  position: number;
  revision: number;
  preview: string;
  attachmentCount: number;
  runTarget: QueuedChatSend["runTarget"] | null;
  /** Whether it goes anonymized; a client hands a running turn only a
   *  message queued to be sent raw. */
  sendMode: QueuedChatSend["sendMode"];
  createdAt: Date;
};

export type ChatQueueHold = {
  reason: ChatQueueHoldReason;
  turnId: SafeId<"chatTurn"> | null;
  queuedMessageId: SafeId<"chatMessage"> | null;
  refusalCode: string | null;
};

/**
 * A stored queued send, validated on read: the column is written only
 * through `queuedChatSendSchema`, so a row that no longer parses is a defect.
 */
export const parseQueuedChatSend = (request: unknown): QueuedChatSend => {
  const parsed = v.safeParse(queuedChatSendSchema, request);
  return parsed.success
    ? parsed.output
    : panic("A stored queued chat message does not parse");
};

/** Whether every attachment the message carries is a stored file already. */
export const hasOnlyStoredAttachments = (send: QueuedChatSend): boolean =>
  send.message.parts.every(
    (part) =>
      !isChatAttachmentPart(part) || isUserFileUrl(getChatAttachmentUrl(part)),
  );

const textOfPart = (part: unknown): string | null =>
  isRecord(part) &&
  part["type"] === "text" &&
  typeof part["content"] === "string"
    ? part["content"]
    : null;

/** The text the member wrote in a queued message, part by part. */
export const queuedChatSendTexts = (send: QueuedChatSend): string[] =>
  send.message.parts.map(textOfPart).filter((piece) => piece !== null);

const itemOfRow = (row: {
  id: SafeId<"chatMessage">;
  position: number;
  revision: number;
  request: unknown;
  createdAt: Date;
}): ChatQueueItem => {
  const send = parseQueuedChatSend(row.request);
  const text = queuedChatSendTexts(send).join("\n").trim();
  return {
    id: row.id,
    position: row.position,
    revision: row.revision,
    preview: text.slice(0, CHAT_QUEUE_PREVIEW_MAX_CHARS),
    attachmentCount: send.message.parts.filter(isChatAttachmentPart).length,
    runTarget: send.runTarget ?? null,
    sendMode: send.sendMode,
    createdAt: row.createdAt,
  };
};

/**
 * Every queued message of a thread. Enqueue admits at most
 * `CHAT_QUEUE_LIMIT` under the thread lock, so more is a defect, not a page.
 */
const wholeQueue = <TRow>(read: BoundedReadResult<TRow>): TRow[] =>
  read.type === "complete"
    ? read.rows
    : panic("A chat thread holds more queued messages than its limit");

const QUEUE_ROW_COLUMNS = {
  id: chatQueuedMessages.id,
  position: chatQueuedMessages.position,
  revision: chatQueuedMessages.revision,
  request: chatQueuedMessages.request,
  createdAt: chatQueuedMessages.createdAt,
} as const;

/** The thread's queue in order, and what holds it. */
export const readChatQueueOnTx = async ({
  threadId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<{ items: ChatQueueItem[]; hold: ChatQueueHold | null }> => {
  const rows = wholeQueue(
    await readBounded(
      tx
        .select(QUEUE_ROW_COLUMNS)
        .from(chatQueuedMessages)
        .where(eq(chatQueuedMessages.threadId, threadId))
        .orderBy(asc(chatQueuedMessages.position)),
      CHAT_QUEUE_LIMIT,
    ),
  );
  const hold = (
    await tx
      .select({
        reason: chatQueueHolds.reason,
        turnId: chatQueueHolds.turnId,
        queuedMessageId: chatQueueHolds.queuedMessageId,
        refusalCode: chatQueueHolds.refusalCode,
      })
      .from(chatQueueHolds)
      .where(eq(chatQueueHolds.threadId, threadId))
      .limit(1)
  ).at(0);
  return { items: rows.map(itemOfRow), hold: hold ?? null };
};

export type EnqueueOutcome =
  | { type: "queued"; item: ChatQueueItem }
  | { type: "already-queued"; item: ChatQueueItem }
  | { type: "full" }
  | { type: "sent" };

/**
 * Queue `send` at the end of the thread's queue under `id`, with the chat
 * files its enqueue stored (`uploadedFileIds`). Idempotent on `id`: a
 * message already queued answers as already queued (keeping the files it was
 * queued with), one already sent as sent. The caller holds the thread lock.
 */
export const enqueueChatMessageOnTx = async ({
  id,
  send,
  threadId,
  tx,
  uploadedFileIds,
}: {
  id: SafeId<"chatMessage">;
  send: QueuedChatSend;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
  uploadedFileIds: readonly SafeId<"userFile">[];
}): Promise<EnqueueOutcome> => {
  const existing = (
    await tx
      .select(QUEUE_ROW_COLUMNS)
      .from(chatQueuedMessages)
      .where(
        and(
          eq(chatQueuedMessages.id, id),
          eq(chatQueuedMessages.threadId, threadId),
        ),
      )
      .limit(1)
  ).at(0);
  if (existing !== undefined) {
    return { type: "already-queued", item: itemOfRow(existing) };
  }
  if (await wasSentOnTx({ id, threadId, tx })) {
    return { type: "sent" };
  }
  const [{ queued } = { queued: 0 }] = await tx
    .select({ queued: count() })
    .from(chatQueuedMessages)
    .where(eq(chatQueuedMessages.threadId, threadId));
  if (queued >= CHAT_QUEUE_LIMIT) {
    return { type: "full" };
  }
  // Owner columns come from the thread, so the row proves the same
  // ownership the thread does (RLS checks the pair).
  const thread = (
    await tx
      .select({
        organizationId: chatThreads.organizationId,
        userId: chatThreads.userId,
        workspaceId: chatThreads.workspaceId,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
      .limit(1)
  ).at(0);
  if (thread === undefined) {
    return panic("A locked chat thread is not readable");
  }
  // audit: skip — the queue route records the enqueue on the thread in this transaction
  const [inserted] = await tx
    .insert(chatQueuedMessages)
    .values({
      id,
      organizationId: thread.organizationId,
      userId: thread.userId,
      workspaceId: thread.workspaceId,
      threadId,
      position: queued + 1,
      request: send,
      uploadedFileIds: [...uploadedFileIds],
    })
    .returning(QUEUE_ROW_COLUMNS);
  return inserted === undefined
    ? panic("A queued chat message insert returned no row")
    : { type: "queued", item: itemOfRow(inserted) };
};

export type QueuedMessageChange =
  | { type: "changed"; item: ChatQueueItem }
  | { type: "sent" }
  | { type: "stale" }
  | { type: "not-found" };

/** The stored revision of queued message `id`, or none when it is not queued. */
export const readQueuedChatMessageRevisionOnTx = async ({
  id,
  threadId,
  tx,
}: {
  id: SafeId<"chatMessage">;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<number | undefined> =>
  (
    await tx
      .select({ revision: chatQueuedMessages.revision })
      .from(chatQueuedMessages)
      .where(
        and(
          eq(chatQueuedMessages.id, id),
          eq(chatQueuedMessages.threadId, threadId),
        ),
      )
      .limit(1)
  ).at(0)?.revision;

/** Queued message `id` whole, with its revision, or none when it is not
 *  queued. */
export const readQueuedChatSendOnTx = async ({
  id,
  threadId,
  tx,
}: {
  id: SafeId<"chatMessage">;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<{ revision: number; send: QueuedChatSend } | undefined> => {
  const row = (
    await tx
      .select({
        request: chatQueuedMessages.request,
        revision: chatQueuedMessages.revision,
      })
      .from(chatQueuedMessages)
      .where(
        and(
          eq(chatQueuedMessages.id, id),
          eq(chatQueuedMessages.threadId, threadId),
        ),
      )
      .limit(1)
  ).at(0);
  return row === undefined
    ? undefined
    : { revision: row.revision, send: parseQueuedChatSend(row.request) };
};

/**
 * Replace a queued message's send, only at the revision the member last saw.
 * The caller holds the thread lock.
 */
export const replaceQueuedChatMessageOnTx = async ({
  expectedRevision,
  id,
  send,
  threadId,
  tx,
}: {
  expectedRevision: number;
  id: SafeId<"chatMessage">;
  send: QueuedChatSend;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<QueuedMessageChange> => {
  // audit: skip — the queue route records the edit on the thread in this transaction
  const [updated] = await tx
    .update(chatQueuedMessages)
    .set({
      request: send,
      revision: sql`${chatQueuedMessages.revision} + 1`,
    })
    .where(
      and(
        eq(chatQueuedMessages.id, id),
        eq(chatQueuedMessages.threadId, threadId),
        eq(chatQueuedMessages.revision, expectedRevision),
      ),
    )
    .returning(QUEUE_ROW_COLUMNS);
  if (updated !== undefined) {
    return { type: "changed", item: itemOfRow(updated) };
  }
  return await missingQueuedMessageOnTx({ id, threadId, tx });
};

const missingQueuedMessageOnTx = async ({
  id,
  threadId,
  tx,
}: {
  id: SafeId<"chatMessage">;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<Exclude<QueuedMessageChange, { type: "changed" }>> => {
  const queued = await tx
    .select({ id: chatQueuedMessages.id })
    .from(chatQueuedMessages)
    .where(
      and(
        eq(chatQueuedMessages.id, id),
        eq(chatQueuedMessages.threadId, threadId),
      ),
    )
    .limit(1);
  if (queued.length === 1) {
    return { type: "stale" };
  }
  return (await wasSentOnTx({ id, threadId, tx }))
    ? { type: "sent" }
    : { type: "not-found" };
};

/**
 * Move `id` before `beforeId` (to the end for `null`), rewriting positions
 * 1..n in one statement. The caller holds the thread lock.
 */
export const moveQueuedChatMessageOnTx = async ({
  beforeId,
  id,
  threadId,
  tx,
}: {
  beforeId: SafeId<"chatMessage"> | null;
  id: SafeId<"chatMessage">;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<"moved" | "not-found"> => {
  const order = wholeQueue(
    await readBounded(
      tx
        .select({ id: chatQueuedMessages.id })
        .from(chatQueuedMessages)
        .where(eq(chatQueuedMessages.threadId, threadId))
        .orderBy(asc(chatQueuedMessages.position)),
      CHAT_QUEUE_LIMIT,
    ),
  ).map((row) => row.id);
  if (
    !order.includes(id) ||
    (beforeId !== null && (beforeId === id || !order.includes(beforeId)))
  ) {
    return "not-found";
  }
  const rest = order.filter((queued) => queued !== id);
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
  const next = [...rest.slice(0, at), id, ...rest.slice(at)];
  // audit: skip — reordering the member's own queue changes no stored content
  await tx
    .update(chatQueuedMessages)
    .set({
      position: sqlCaseFragment({
        branches: next.map(
          (queued, index) =>
            sql`WHEN ${chatQueuedMessages.id} = ${queued}::uuid THEN ${index + 1}::integer`,
        ),
        fallback: sql`${chatQueuedMessages.position}`,
      }),
    })
    .where(
      and(
        eq(chatQueuedMessages.threadId, threadId),
        inArray(chatQueuedMessages.id, next),
      ),
    );
  return "moved";
};

/**
 * Lock the member's own thread for a queue change (the `chatThread`
 * aggregate, the row the thread's turns lock too), so it serializes with
 * them; undefined when the thread is not theirs.
 */
export const lockOwnQueueThreadOnTx = async ({
  organizationId,
  threadId,
  tx,
  userId,
}: {
  organizationId: SafeId<"organization">;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
  userId: SafeId<"user">;
}): Promise<{ workspaceId: SafeId<"workspace"> | null } | undefined> => {
  await withAggregateLock({
    aggregate: "chatThread",
    mode: "update",
    tx,
    id: { id: threadId, organizationId, userId },
  });
  return (
    await tx
      .select({ workspaceId: chatThreads.workspaceId })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, threadId),
          eq(chatThreads.organizationId, organizationId),
          eq(chatThreads.userId, userId),
        ),
      )
      .limit(1)
  ).at(0);
};
