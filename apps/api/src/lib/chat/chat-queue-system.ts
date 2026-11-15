import { and, asc, eq, inArray, sql } from "drizzle-orm";

import {
  CHAT_QUEUE_HOLD_REASON,
  CHAT_QUEUE_SEND_REFUSAL,
} from "@stll/api-contract/chat-queue";

import type { Transaction } from "@/api/db/root";
import { chatQueuedMessages, chatQueueHolds, chatTurns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { replayWrite } from "@/api/lib/case-law/replay-write";
import {
  type DueQueuedChatMessage,
  holdDueChatQueueOnTx,
} from "@/api/lib/chat/chat-queue-gate";
import { ACTIVE_CHAT_TURN_STATUSES } from "@/api/lib/chat/turn-status";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

/**
 * The queue's reads and writes that no member's connection can make: which
 * threads have a message due across every organization, who queued one
 * before that member is proved again, and a hold for a member who can no
 * longer act. Crosses organizations by design, as the turn reaper does; it
 * reads ids and owners only, never a queued message's content, and sends
 * nothing itself. Only the owner connection's doors in `db/root.ts` run
 * these.
 */

/** The due head of a thread's queue and who queued it. */
type DueQueueHead = DueQueuedChatMessage & {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

/**
 * The thread's first queued message when the queue's gate is open for it:
 * no hold and no active turn (`readChatQueueGateOnTx` decides again under
 * the member's own connection and the thread lock).
 */
export const readDueQueueHeadOnTx = async ({
  threadId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<DueQueueHead | null> => {
  const head = (
    await tx
      .select({
        id: chatQueuedMessages.id,
        revision: chatQueuedMessages.revision,
        organizationId: chatQueuedMessages.organizationId,
        userId: chatQueuedMessages.userId,
      })
      .from(chatQueuedMessages)
      .where(
        and(
          eq(chatQueuedMessages.threadId, threadId),
          sql`NOT EXISTS (SELECT 1 FROM ${chatQueueHolds} WHERE ${chatQueueHolds.threadId} = ${threadId})`,
          sql`NOT EXISTS (SELECT 1 FROM ${chatTurns} WHERE ${chatTurns.threadId} = ${threadId} AND ${inArray(chatTurns.status, ACTIVE_CHAT_TURN_STATUSES)})`,
        ),
      )
      .orderBy(asc(chatQueuedMessages.position))
      .limit(1)
  ).at(0);
  return head === undefined
    ? null
    : { ...head, userId: brandPersistedUserId(head.userId) };
};

/**
 * Up to `limit` threads, in any organization, whose queue has a message due
 * (no hold, no active turn), the ones a sweep tried longest ago first, and
 * mark them tried now. A thread whose send keeps answering "later" goes to
 * the back each time, so a bounded sweep reaches every due thread in turn.
 */
export const sweepThreadsWithDueQueueOnTx = async ({
  limit,
  tx,
}: {
  limit: number;
  tx: Transaction;
}): Promise<SafeId<"chatThread">[]> => {
  const due = tx
    .select({ threadId: chatQueuedMessages.threadId })
    .from(chatQueuedMessages)
    .where(
      and(
        sql`NOT EXISTS (SELECT 1 FROM ${chatQueueHolds} WHERE ${chatQueueHolds.threadId} = ${chatQueuedMessages.threadId})`,
        sql`NOT EXISTS (SELECT 1 FROM ${chatTurns} WHERE ${chatTurns.threadId} = ${chatQueuedMessages.threadId} AND ${inArray(chatTurns.status, ACTIVE_CHAT_TURN_STATUSES)})`,
      ),
    )
    .groupBy(chatQueuedMessages.threadId)
    .orderBy(
      sql`max(${chatQueuedMessages.sweptAt}) ASC NULLS FIRST`,
      asc(chatQueuedMessages.threadId),
    )
    .limit(limit);
  const mark = replayWrite(chatQueuedMessages, {
    sweptAt: sql`now()`,
    // Bookkeeping of the sweep, not an edit of the message.
    updatedAt: sql`${chatQueuedMessages.updatedAt}`,
  });
  // audit: skip — when a sweep last tried a queue orders the next sweep; no stored content changes
  const swept = await tx
    .update(chatQueuedMessages)
    .set(mark.set)
    .where(and(inArray(chatQueuedMessages.threadId, due), mark.setWhere))
    .returning({ threadId: chatQueuedMessages.threadId });
  return [...new Set(swept.map(({ threadId }) => threadId))];
};

/**
 * Hold a thread's queue because its member can no longer be proved: no
 * connection of that member can write it. Only while the message tried is
 * still the due head, so a pause or an edit since stands. The refusal names
 * the head.
 */
export const holdQueueOfUnavailableMemberOnTx = async ({
  head,
  threadId,
  tx,
}: {
  head: DueQueuedChatMessage;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<void> => {
  await holdDueChatQueueOnTx({
    head,
    hold: {
      reason: CHAT_QUEUE_HOLD_REASON.sendRefused,
      queuedMessageId: head.id,
      refusalCode: CHAT_QUEUE_SEND_REFUSAL.memberUnavailable,
    },
    threadId,
    tx,
  });
};
