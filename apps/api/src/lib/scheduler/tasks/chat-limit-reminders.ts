import { panic } from "better-result";
import { inArray } from "drizzle-orm";

import { chatLimitReminders } from "@/api/db/schema";
import type { Transaction } from "@/api/db/types";
import { notifyChatLimitResetOnTx } from "@/api/lib/chat/limit-reset-notification";
import { withSkipLockedBatch } from "@/api/lib/db/aggregate-lock";
import {
  dueChatLimitNotificationsSelect,
  type DueChatLimitReminder,
} from "@/api/lib/db/chat-limit-reminder-system";
import {
  type NotificationPing,
  pingNotificationRecipients,
} from "@/api/lib/notifications";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const SEND_CHAT_LIMIT_REMINDERS_TASK =
  "chat.sendLimitReminders" as const;

/** Reminders handled per run; a larger backlog continues on the next run. */
const REMINDER_BATCH_SIZE = 200;

type ReminderSweepResult = {
  due: number;
  notified: number;
  pings: NotificationPing[];
};

const fileDueReminders = async (
  tx: Transaction,
  due: readonly DueChatLimitReminder[],
): Promise<ReminderSweepResult> => {
  // audit: skip - delivers a reminder the member asked for; the notification it files is the record.
  if (due.length === 0) {
    return { due: 0, notified: 0, pings: [] };
  }
  await tx.delete(chatLimitReminders).where(
    inArray(
      chatLimitReminders.threadId,
      due.map(({ threadId }) => threadId),
    ),
  );
  const pings = await notifyChatLimitResetOnTx(tx, due);
  return { due: due.length, notified: pings.length, pings };
};

/**
 * Take the reminders due at `now` and file one notification per chat whose
 * latest turn is still the one that hit the limit. A chat the member already
 * continued gets nothing. A request to continue the chat is taken only once
 * its window passed without the chat continuing (the limit resumer tries it
 * until then), so it ends in the notification. Taking the rows and filing
 * the notifications commit together, so a crash between them neither loses a
 * reminder nor sends it twice (the idempotency key is the turn).
 */
export const takeDueChatLimitReminders = async ({
  database,
  now,
}: {
  database: {
    transaction: <Value>(
      run: (tx: Transaction) => Promise<Value>,
    ) => Promise<Value>;
  };
  now: Date;
}): Promise<ReminderSweepResult> =>
  await withSkipLockedBatch({
    database,
    limit: REMINDER_BATCH_SIZE,
    select: (tx) => dueChatLimitNotificationsSelect(tx, now),
    run: fileDueReminders,
  });

/**
 * Tell members whose chat stopped on their computer's usage limit, and who
 * asked to hear about it, that the limit has reset. Crosses organizations by
 * design, so it runs on the scheduler's system connection; it reads ids and
 * times only, never chat content.
 */
export const sendChatLimitReminders: SchedulerTask = async ({
  db,
  dueAt,
  logger,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  const { due, notified, pings } = await takeDueChatLimitReminders({
    database: db,
    now: dueAt.claimedAtDate(),
  });
  pingNotificationRecipients(pings);
  logger.info("scheduler.chat_limit_reminders_sent", {
    "chatLimitReminders.due": due,
    "chatLimitReminders.notified": notified,
  });
};
