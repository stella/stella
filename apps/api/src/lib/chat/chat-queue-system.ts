import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { CHAT_QUEUE_HOLD_REASON } from "@stll/api-contract/chat-queue";

import { rootDb } from "@/api/db/root";
import { chatQueuedMessages, chatQueueHolds, chatTurns } from "@/api/db/schema";
import { lockChatThreadForTurnOnTx } from "@/api/handlers/chat/chat-turn-persistence";
import { holdChatQueueOnTx } from "@/api/handlers/chat/queue/chat-queue-gate";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

/**
 * The queue's reads and writes that no member's connection can make: which
 * threads have a message due across every organization, who queued one
 * before that member is proved again, and a hold for a member who can no
 * longer act. Crosses organizations by design, as the turn reaper does; it
 * reads ids and owners only, never a queued message's content, and sends
 * nothing itself.
 */

const BLOCKING_TURN_STATUSES = {
  queue: ["accepted", "running", "awaiting-user"],
  replace: ["accepted", "running"],
} as const;

/** The due head of a thread's queue and who queued it, or none. */
export type DueQueueHead = {
  queuedMessageId: SafeId<"chatMessage">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

/**
 * The thread's first queued message when the queue's gate is open for it:
 * no hold and no turn that blocks (`whileWaiting` as in
 * `readChatQueueGateOnTx`, which decides again under the member's lock).
 */
export const readDueQueueHead = async ({
  threadId,
  whileWaiting,
}: {
  threadId: SafeId<"chatThread">;
  whileWaiting: "queue" | "replace";
}): Promise<DueQueueHead | null> => {
  const head = (
    await rootDb
      .select({
        queuedMessageId: chatQueuedMessages.id,
        organizationId: chatQueuedMessages.organizationId,
        userId: chatQueuedMessages.userId,
      })
      .from(chatQueuedMessages)
      .where(
        and(
          eq(chatQueuedMessages.threadId, threadId),
          sql`NOT EXISTS (SELECT 1 FROM ${chatQueueHolds} WHERE ${chatQueueHolds.threadId} = ${threadId})`,
          sql`NOT EXISTS (SELECT 1 FROM ${chatTurns} WHERE ${chatTurns.threadId} = ${threadId} AND ${inArray(chatTurns.status, BLOCKING_TURN_STATUSES[whileWaiting])})`,
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
 * Threads, in any organization, whose queue has a message due: no hold and
 * no active turn. Bounded; the next sweep continues.
 */
export const listThreadsWithDueQueue = async (
  limit: number,
): Promise<SafeId<"chatThread">[]> =>
  (
    await rootDb
      .selectDistinct({ threadId: chatQueuedMessages.threadId })
      .from(chatQueuedMessages)
      .where(
        and(
          sql`NOT EXISTS (SELECT 1 FROM ${chatQueueHolds} WHERE ${chatQueueHolds.threadId} = ${chatQueuedMessages.threadId})`,
          sql`NOT EXISTS (SELECT 1 FROM ${chatTurns} WHERE ${chatTurns.threadId} = ${chatQueuedMessages.threadId} AND ${inArray(chatTurns.status, BLOCKING_TURN_STATUSES.queue)})`,
        ),
      )
      .limit(limit)
  ).map(({ threadId }) => threadId);

/**
 * Hold a thread's queue because its member can no longer be proved: no
 * connection of that member can write it. The refusal names the head.
 */
export const holdQueueOfUnavailableMember = async ({
  queuedMessageId,
  refusalCode,
  threadId,
}: {
  queuedMessageId: SafeId<"chatMessage">;
  refusalCode: string;
  threadId: SafeId<"chatThread">;
}): Promise<void> => {
  await withAggregateTransaction(rootDb, async (tx) => {
    if (!(await lockChatThreadForTurnOnTx({ threadId, tx }))) {
      return;
    }
    await holdChatQueueOnTx({
      hold: {
        reason: CHAT_QUEUE_HOLD_REASON.sendRefused,
        queuedMessageId,
        refusalCode,
      },
      threadId,
      tx,
    });
  });
};
