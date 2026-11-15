import { panic } from "better-result";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import {
  CHAT_QUEUE_HOLD_REASON,
  type ChatQueueHoldReason,
} from "@stll/api-contract/chat-queue";

import type { Transaction } from "@/api/db/root";
import {
  chatMessages,
  chatQueuedMessages,
  chatQueueHolds,
  chatThreads,
  chatTurns,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { replayWrite } from "@/api/lib/case-law/replay-write";
import { ACTIVE_CHAT_TURN_STATUSES } from "@/api/lib/chat/turn-status";
import { lockChatThreadForTurnOnTx } from "@/api/lib/db/aggregate-lock";

/**
 * When a thread's queue may send, and the writes that keep it consistent
 * with the thread's turns: holds, and taking the next message for a turn.
 * Every write here runs under the thread lock, so this module reads no
 * message content and decides nothing about a turn.
 */

/** Whether `id` was sent: it is a stored message of the thread. */
export const wasSentOnTx = async ({
  id,
  threadId,
  tx,
}: {
  id: SafeId<"chatMessage">;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<boolean> =>
  (
    await tx
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(and(eq(chatMessages.id, id), eq(chatMessages.threadId, threadId)))
      .limit(1)
  ).length === 1;

/** Delete the hold once its thread has nothing queued (one hold, only with rows). */
const dropHoldOfEmptyQueueOnTx = async ({
  threadId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<void> => {
  // audit: skip — a hold only describes why queued messages wait; with none left it describes nothing
  await tx
    .delete(chatQueueHolds)
    .where(
      and(
        eq(chatQueueHolds.threadId, threadId),
        sql`NOT EXISTS (SELECT 1 FROM ${chatQueuedMessages} WHERE ${chatQueuedMessages.threadId} = ${threadId})`,
      ),
    );
};

/** Close the gap a removed row left, so positions stay 1..n. */
const closePositionGapOnTx = async ({
  position,
  threadId,
  tx,
}: {
  position: number;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<void> => {
  const shift = replayWrite(chatQueuedMessages, {
    position: sql`${chatQueuedMessages.position} - 1`,
  });
  // audit: skip — renumbering the remaining queue after an audited removal
  await tx
    .update(chatQueuedMessages)
    .set(shift.set)
    .where(
      and(
        eq(chatQueuedMessages.threadId, threadId),
        gt(chatQueuedMessages.position, position),
        shift.setWhere,
      ),
    );
};

export type QueuedMessageRemoval =
  | { type: "removed"; request: unknown }
  | { type: "sent" }
  | { type: "not-found" };

/**
 * Remove a queued message, keeping positions 1..n and the hold only while
 * something is queued. The caller holds the thread lock.
 */
export const removeQueuedChatMessageOnTx = async ({
  id,
  threadId,
  tx,
}: {
  id: SafeId<"chatMessage">;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<QueuedMessageRemoval> => {
  // audit: skip — the caller records the cancel, or stores the message it sends, in this transaction
  const [removed] = await tx
    .delete(chatQueuedMessages)
    .where(
      and(
        eq(chatQueuedMessages.id, id),
        eq(chatQueuedMessages.threadId, threadId),
      ),
    )
    .returning({
      position: chatQueuedMessages.position,
      request: chatQueuedMessages.request,
    });
  if (removed === undefined) {
    return (await wasSentOnTx({ id, threadId, tx }))
      ? { type: "sent" }
      : { type: "not-found" };
  }
  await closePositionGapOnTx({ position: removed.position, threadId, tx });
  await dropHoldOfEmptyQueueOnTx({ threadId, tx });
  return { type: "removed", request: removed.request };
};

export type ChatQueueHoldWrite =
  | { reason: "member" | "usage-limit" | "computer-away" }
  | { reason: "turn-failed" | "turn-interrupted"; turnId: SafeId<"chatTurn"> }
  | {
      reason: "send-refused";
      queuedMessageId: SafeId<"chatMessage">;
      refusalCode: string;
    };

/**
 * Hold the thread's queue, only while it has queued messages. A hold already
 * there stands until it is released: a member's pause is never replaced by
 * a reason the server finds later, and any hold keeps the queue alike.
 */
export const holdChatQueueOnTx = async ({
  hold,
  threadId,
  tx,
}: {
  hold: ChatQueueHoldWrite;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<void> => {
  const values = (() => {
    switch (hold.reason) {
      case "member":
      case "usage-limit":
      case "computer-away":
        return { turnId: null, queuedMessageId: null, refusalCode: null };
      case "turn-failed":
      case "turn-interrupted":
        return {
          turnId: hold.turnId,
          queuedMessageId: null,
          refusalCode: null,
        };
      case "send-refused":
        return {
          turnId: null,
          queuedMessageId: hold.queuedMessageId,
          refusalCode: hold.refusalCode,
        };
      default:
        hold satisfies never;
        return panic("Unhandled queue hold");
    }
  })();
  // Owner columns come from the thread, and the row is written only while
  // the thread has a queued message.
  // The table is named in the text so the conflict target reads as this
  // table's key, not a chat turn's (scripts/check-online-index-dependencies.ts).
  // audit: skip — a hold records why queued messages wait; the turn or refusal that caused it is recorded where it happened
  await tx.execute(sql`
    INSERT INTO chat_queue_holds (
      thread_id, organization_id, workspace_id, user_id, reason,
      turn_id, queued_message_id, refusal_code
    )
    SELECT ct.id, ct.organization_id, ct.workspace_id, ct.user_id,
      ${hold.reason}, ${values.turnId}::uuid, ${values.queuedMessageId}::uuid,
      ${values.refusalCode}::text
    FROM ${chatThreads} ct
    WHERE ct.id = ${threadId}
      AND EXISTS (
        SELECT 1 FROM ${chatQueuedMessages} q WHERE q.thread_id = ${threadId}
      )
    ON CONFLICT (thread_id) DO NOTHING
  `);
};

/** Release the thread's queue: the member resumed it or sent a message. */
export const releaseChatQueueOnTx = async ({
  threadId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<void> => {
  // audit: skip — releasing a hold changes no stored content; the send or resume that released it is the record
  await tx.delete(chatQueueHolds).where(eq(chatQueueHolds.threadId, threadId));
};

/** The next queued message, as stored. */
type QueuedChatHead = {
  id: SafeId<"chatMessage">;
  revision: number;
  /** The stored send; `parseQueuedChatSend` reads it. */
  request: unknown;
};

/** Whether the thread's queue may send its first message now, and which. */
export type ChatQueueGate =
  | { type: "due"; head: QueuedChatHead }
  | { type: "empty" }
  | { type: "held"; reason: ChatQueueHoldReason }
  | { type: "turn-active" };

/**
 * The one gate of the queue: a queued message goes only when the thread has
 * no hold and no active turn. A turn waiting on the member is active, so no
 * wait of any kind lets the queue go; Send now ends such a turn first. The
 * caller holds the thread lock and has ended a running turn whose lease
 * lapsed (`canAcceptChatTurnOnTx`).
 */
export const readChatQueueGateOnTx = async ({
  threadId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<ChatQueueGate> => {
  const head = (
    await tx
      .select({
        id: chatQueuedMessages.id,
        revision: chatQueuedMessages.revision,
        request: chatQueuedMessages.request,
      })
      .from(chatQueuedMessages)
      .where(eq(chatQueuedMessages.threadId, threadId))
      .orderBy(asc(chatQueuedMessages.position))
      .limit(1)
  ).at(0);
  if (head === undefined) {
    return { type: "empty" };
  }
  const hold = (
    await tx
      .select({ reason: chatQueueHolds.reason })
      .from(chatQueueHolds)
      .where(eq(chatQueueHolds.threadId, threadId))
      .limit(1)
  ).at(0);
  if (hold !== undefined) {
    return { type: "held", reason: hold.reason };
  }
  const active = await tx
    .select({ id: chatTurns.id })
    .from(chatTurns)
    .where(
      and(
        eq(chatTurns.threadId, threadId),
        inArray(chatTurns.status, ACTIVE_CHAT_TURN_STATUSES),
      ),
    )
    .limit(1);
  if (active.length > 0) {
    return { type: "turn-active" };
  }
  return {
    type: "due",
    head: {
      id: head.id,
      revision: head.revision,
      request: head.request,
    },
  };
};

/** The queued message the sender read, by id and revision. */
export type DueQueuedChatMessage = {
  id: SafeId<"chatMessage">;
  revision: number;
};

/** Whether `id` at `revision` is still the due head of an open gate. */
const isDueHeadOnTx = async ({
  id,
  revision,
  threadId,
  tx,
}: DueQueuedChatMessage & {
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<boolean> => {
  const gate = await readChatQueueGateOnTx({ threadId, tx });
  return (
    gate.type === "due" &&
    gate.head.id === id &&
    gate.head.revision === revision
  );
};

/**
 * Hold the queue for a refusal the sender met outside the thread lock, only
 * while the message it tried is still the due head: a pause, an edit, a
 * removal or a turn since then is newer than the refusal and stands.
 */
export const holdDueChatQueueOnTx = async ({
  head,
  hold,
  threadId,
  tx,
}: {
  head: DueQueuedChatMessage;
  hold: ChatQueueHoldWrite;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<"held" | "not-due"> => {
  if (
    !(await lockChatThreadForTurnOnTx({ threadId, tx })) ||
    !(await isDueHeadOnTx({ ...head, threadId, tx }))
  ) {
    return "not-due";
  }
  await holdChatQueueOnTx({ hold, threadId, tx });
  return "held";
};

/**
 * Take the queued message `id` at `revision` for the turn being accepted in
 * this transaction: it must be the due head of an open gate. Deleting it here,
 * in the transaction that stores it as a message, puts it in exactly one of
 * the two places at every commit; a later failure rolls both back. An edit
 * committed since the sender read it changed `revision`, so nothing is taken
 * and the sender starts over with the new body.
 */
export const takeQueuedChatMessageOnTx = async ({
  id,
  revision,
  threadId,
  tx,
}: {
  id: SafeId<"chatMessage">;
  revision: number;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<"taken" | "not-due"> => {
  if (!(await isDueHeadOnTx({ id, revision, threadId, tx }))) {
    return "not-due";
  }
  const removed = await removeQueuedChatMessageOnTx({ id, threadId, tx });
  return removed.type === "removed" ? "taken" : "not-due";
};

/**
 * Release every queue of the member held because their computer was away:
 * one of their computers just reported. Answers the threads released, which
 * the caller rings; a computer still away holds them again on the next try.
 */
export const releaseComputerAwayHoldsOnTx = async ({
  organizationId,
  tx,
  userId,
}: {
  organizationId: SafeId<"organization">;
  tx: Transaction;
  userId: SafeId<"user">;
}): Promise<SafeId<"chatThread">[]> => {
  // audit: skip — releasing a hold changes no stored content; the queued message it lets go is audited when sent
  const released = await tx
    .delete(chatQueueHolds)
    .where(
      and(
        eq(chatQueueHolds.organizationId, organizationId),
        eq(chatQueueHolds.userId, userId),
        eq(chatQueueHolds.reason, CHAT_QUEUE_HOLD_REASON.computerAway),
      ),
    )
    .returning({ threadId: chatQueueHolds.threadId });
  return released.map(({ threadId }) => threadId);
};
