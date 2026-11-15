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
import { lockChatThreadForTurnOnTx } from "@/api/handlers/chat/chat-turn-persistence";
import { wasSentOnTx } from "@/api/handlers/chat/queue/chat-queue-gate";
import type { SafeId } from "@/api/lib/branded-types";
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

const itemOfRow = (row: {
  id: SafeId<"chatMessage">;
  position: number;
  revision: number;
  request: unknown;
  createdAt: Date;
}): ChatQueueItem => {
  const send = parseQueuedChatSend(row.request);
  const text = send.message.parts
    .map(textOfPart)
    .filter((piece) => piece !== null)
    .join("\n")
    .trim();
  return {
    id: row.id,
    position: row.position,
    revision: row.revision,
    preview: text.slice(0, CHAT_QUEUE_PREVIEW_MAX_CHARS),
    attachmentCount: send.message.parts.filter(isChatAttachmentPart).length,
    runTarget: send.runTarget ?? null,
    createdAt: row.createdAt,
  };
};

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
  const rows = await tx
    .select(QUEUE_ROW_COLUMNS)
    .from(chatQueuedMessages)
    .where(eq(chatQueuedMessages.threadId, threadId))
    .orderBy(asc(chatQueuedMessages.position))
    .limit(CHAT_QUEUE_LIMIT);
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
  { type: "queued"; item: ChatQueueItem } | { type: "full" } | { type: "sent" };

/**
 * Queue `send` at the end of the thread's queue under `id`. Idempotent on
 * `id`: a message already queued answers as queued, one already sent as
 * sent. The caller holds the thread lock.
 */
export const enqueueChatMessageOnTx = async ({
  id,
  send,
  threadId,
  tx,
}: {
  id: SafeId<"chatMessage">;
  send: QueuedChatSend;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
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
    return { type: "queued", item: itemOfRow(existing) };
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
  const order = (
    await tx
      .select({ id: chatQueuedMessages.id })
      .from(chatQueuedMessages)
      .where(eq(chatQueuedMessages.threadId, threadId))
      .orderBy(asc(chatQueuedMessages.position))
      .limit(CHAT_QUEUE_LIMIT)
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
 * Lock the member's own thread for a queue change, so it serializes with the
 * thread's turns; undefined when the thread is not theirs.
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
  if (!(await lockChatThreadForTurnOnTx({ threadId, tx }))) {
    return undefined;
  }
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
