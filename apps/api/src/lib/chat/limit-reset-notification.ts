import { and, eq, inArray } from "drizzle-orm";

import { CHAT_LIMIT_RESET_ACTION } from "@stll/api-contract/chat-limit-reminder";
import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";

import type { Transaction } from "@/api/db/root";
import { chatLimitReminders, chatThreads, chatTurns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { NEWEST_CHAT_TURN_FIRST } from "@/api/lib/chat/turn-order";
import {
  DUE_CHAT_LIMIT_REMINDER_COLUMNS,
  type DueChatLimitReminder,
} from "@/api/lib/db/chat-limit-reminder-system";
import {
  createNotificationsInTransaction,
  type NewNotification,
  type NotificationPing,
} from "@/api/lib/notifications";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

/**
 * File one notification per chat whose latest turn is still the one that hit
 * the limit; a chat the member already continued gets nothing. The caller
 * has deleted the reminders in this transaction. The idempotency key is the
 * turn, so a chat is never told twice about one limit.
 */
export const notifyChatLimitResetOnTx = async (
  tx: Transaction,
  due: readonly DueChatLimitReminder[],
): Promise<NotificationPing[]> => {
  if (due.length === 0) {
    return [];
  }
  // The newest turn of each chat, ordered as readLimitedLatestTurn orders it;
  // DISTINCT ON keeps exactly one row per chat, so the limit is exact.
  const latest = await tx
    .selectDistinctOn([chatTurns.threadId], {
      threadId: chatTurns.threadId,
      turnId: chatTurns.id,
    })
    .from(chatTurns)
    .where(
      inArray(
        chatTurns.threadId,
        due.map(({ threadId }) => threadId),
      ),
    )
    .orderBy(chatTurns.threadId, ...NEWEST_CHAT_TURN_FIRST)
    .limit(due.length);
  const latestTurnOf = new Map(
    latest.map(({ threadId, turnId }) => [threadId, turnId]),
  );
  const waiting = due.filter(
    ({ threadId, turnId }) => latestTurnOf.get(threadId) === turnId,
  );
  return await fileChatLimitResetNotificationsOnTx(tx, waiting);
};

/** File the limit reset notification of each request, by its turn, once. */
const fileChatLimitResetNotificationsOnTx = async (
  tx: Transaction,
  waiting: readonly DueChatLimitReminder[],
): Promise<NotificationPing[]> => {
  if (waiting.length === 0) {
    return [];
  }
  const threads = await tx
    .select({ id: chatThreads.id, workspaceId: chatThreads.workspaceId })
    .from(chatThreads)
    .where(
      inArray(
        chatThreads.id,
        waiting.map(({ threadId }) => threadId),
      ),
    );
  const workspaceOf = new Map(threads.map((row) => [row.id, row.workspaceId]));
  const rows = waiting.map(
    (reminder) =>
      ({
        kind: NOTIFICATION_KIND.LOCAL_RUN_LIMIT_RESET,
        metadata: {},
        userId: brandPersistedUserId(reminder.userId),
        organizationId: reminder.organizationId,
        idempotencyKey: `local-run-limit-reset:${reminder.turnId}`,
        entityType: "chat_thread",
        entityId: reminder.threadId,
        workspaceId: workspaceOf.get(reminder.threadId) ?? null,
      }) satisfies NewNotification,
  );
  return await createNotificationsInTransaction(rows, tx);
};

/**
 * What becomes of a request to continue a chat that will not start: the
 * member is `notify`-ed that the limit reset (their computer is away, or the
 * limit is still reached), or it is `discard`-ed (the chat moved on, or the
 * member can no longer see it).
 */
export type ChatLimitResumeEnd = "notify" | "discard";

/**
 * End the request to continue the chat after the limit that stopped
 * `turnId`, only while it is still stored: a resume that started the turn
 * meanwhile took it, and then nothing is filed. Runs on the member's own
 * connection. Answers the notifications filed, for the caller to ring.
 */
export const endChatLimitResumeOnTx = async ({
  end,
  threadId,
  turnId,
  tx,
}: {
  end: ChatLimitResumeEnd;
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
  tx: Transaction;
}): Promise<NotificationPing[]> => {
  // audit: skip — ends a request the member made; the notification it files is the record
  const ended = await tx
    .delete(chatLimitReminders)
    .where(
      and(
        eq(chatLimitReminders.threadId, threadId),
        eq(chatLimitReminders.turnId, turnId),
        eq(chatLimitReminders.onReset, CHAT_LIMIT_RESET_ACTION.continue),
      ),
    )
    .returning(DUE_CHAT_LIMIT_REMINDER_COLUMNS);
  return end === "notify" ? await notifyChatLimitResetOnTx(tx, ended) : [];
};

/** What became of a request to continue a chat whose resend was refused. */
export type RefusedChatLimitResumeEnd =
  /** Still stored, after a refusal that may pass: the next sweep tries again. */
  | { type: "kept" }
  /** The member is told the limit reset. */
  | { type: "ended"; pings: NotificationPing[] }
  /** Taken by a turn that started, or cancelled: nothing to do. */
  | { type: "not-due" };

/**
 * End the request to continue the chat after the resend the member asked for
 * was refused. A refusal before the send's acceptance leaves the request
 * stored: one that may pass on its own (`transient`) keeps it for the next
 * sweep, any other ends it in the notification. A refusal after the
 * acceptance took it (the admission or the computer refusing the new turn,
 * which the chat then shows as failed) leaves nothing to retry or end, so the
 * member is told now; the turn's key keeps that to once. A request taken by a
 * turn that is running, or cancelled, is left alone. Runs on the member's own
 * connection; the caller holds the thread lock.
 */
export const endRefusedChatLimitResumeOnTx = async ({
  due,
  transient,
  tx,
}: {
  due: DueChatLimitReminder;
  transient: boolean;
  tx: Transaction;
}): Promise<RefusedChatLimitResumeEnd> => {
  const { threadId, turnId } = due;
  const [stored] = await tx
    .select({ turnId: chatLimitReminders.turnId })
    .from(chatLimitReminders)
    .where(
      and(
        eq(chatLimitReminders.threadId, threadId),
        eq(chatLimitReminders.turnId, turnId),
        eq(chatLimitReminders.onReset, CHAT_LIMIT_RESET_ACTION.continue),
      ),
    )
    .limit(1);
  if (stored !== undefined) {
    return transient
      ? { type: "kept" }
      : {
          type: "ended",
          pings: await endChatLimitResumeOnTx({
            end: "notify",
            threadId,
            turnId,
            tx,
          }),
        };
  }
  const [latest] = await tx
    .select({ id: chatTurns.id, status: chatTurns.status })
    .from(chatTurns)
    .where(eq(chatTurns.threadId, threadId))
    .orderBy(...NEWEST_CHAT_TURN_FIRST)
    .limit(1);
  if (
    latest === undefined ||
    latest.id === turnId ||
    latest.status !== "failed"
  ) {
    return { type: "not-due" };
  }
  return {
    type: "ended",
    pings: await fileChatLimitResetNotificationsOnTx(tx, [due]),
  };
};
