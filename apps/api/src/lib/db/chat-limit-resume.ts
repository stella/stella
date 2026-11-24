import { and, eq } from "drizzle-orm";

import { CHAT_LIMIT_RESET_ACTION } from "@stll/api-contract/chat-limit-reminder";

import { chatLimitReminders, chatTurns } from "@/api/db/schema";
import type { Transaction } from "@/api/db/types";
import type { SafeId } from "@/api/lib/branded-types";
import { NEWEST_CHAT_TURN_FIRST } from "@/api/lib/chat/turn-order";
import { releaseChatQueueOnTx } from "@/api/lib/db/chat-queue-gate";

/**
 * Take the member's request to continue the chat after the usage limit that
 * stopped `failedTurnId` reset, for the turn being accepted in this
 * transaction: only while that turn is still the thread's latest, and only
 * once. Deleting the request here, in the transaction that stores the new
 * turn, means two API tasks resuming the same chat start one turn: the
 * second finds nothing to take. A queue held behind the stopped turn is
 * released, as the member's own resend releases it, so the resumed turn goes
 * first and the queue sends after it. The caller holds the thread lock.
 */
export const takeChatLimitResumeOnTx = async ({
  failedTurnId,
  threadId,
  tx,
}: {
  failedTurnId: SafeId<"chatTurn">;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<"taken" | "not-due"> => {
  const [latest] = await tx
    .select({ id: chatTurns.id })
    .from(chatTurns)
    .where(eq(chatTurns.threadId, threadId))
    .orderBy(...NEWEST_CHAT_TURN_FIRST)
    .limit(1);
  if (latest?.id !== failedTurnId) {
    return "not-due";
  }
  // audit: skip — the request is consumed by the turn it starts, which is audited in this transaction
  const taken = await tx
    .delete(chatLimitReminders)
    .where(
      and(
        eq(chatLimitReminders.threadId, threadId),
        eq(chatLimitReminders.turnId, failedTurnId),
        eq(chatLimitReminders.onReset, CHAT_LIMIT_RESET_ACTION.continue),
      ),
    )
    .returning({ threadId: chatLimitReminders.threadId });
  if (taken.length === 0) {
    return "not-due";
  }
  await releaseChatQueueOnTx({ threadId, tx });
  return "taken";
};
