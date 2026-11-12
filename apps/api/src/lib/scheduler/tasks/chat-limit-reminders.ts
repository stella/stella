import { panic } from "better-result";
import { desc, inArray, lte, sql } from "drizzle-orm";

import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";

import type { Transaction } from "@/api/db/root";
import { chatLimitReminders, chatThreads, chatTurns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { withSkipLockedBatch } from "@/api/lib/db/aggregate-lock";
import {
  createNotificationsInTransaction,
  type NewNotification,
  type NotificationPing,
  pingNotificationRecipients,
} from "@/api/lib/notifications";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const SEND_CHAT_LIMIT_REMINDERS_TASK =
  "chat.sendLimitReminders" as const;

/** Reminders handled per run; a larger backlog continues on the next run. */
const REMINDER_BATCH_SIZE = 200;

type DueReminder = {
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
  organizationId: SafeId<"organization">;
  userId: string;
};

type ReminderSweepResult = {
  due: number;
  notified: number;
  pings: NotificationPing[];
};

const fileDueReminders = async (
  tx: Transaction,
  due: readonly DueReminder[],
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
    .orderBy(chatTurns.threadId, desc(chatTurns.createdAt), desc(chatTurns.id))
    .limit(due.length);
  const latestTurnOf = new Map(
    latest.map(({ threadId, turnId }) => [threadId, turnId]),
  );
  const waiting = due.filter(
    ({ threadId, turnId }) => latestTurnOf.get(threadId) === turnId,
  );
  if (waiting.length === 0) {
    return { due: due.length, notified: 0, pings: [] };
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
  return {
    due: due.length,
    notified: rows.length,
    pings: await createNotificationsInTransaction(rows, tx),
  };
};

/**
 * Take the reminders due at `now` and file one notification per chat whose
 * latest turn is still the one that hit the limit. A chat the member already
 * continued gets nothing. Taking the rows and filing the notifications commit
 * together, so a crash between them neither loses a reminder nor sends it
 * twice (the idempotency key is the turn).
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
    select: (tx) =>
      tx
        .select({
          threadId: chatLimitReminders.threadId,
          turnId: chatLimitReminders.turnId,
          organizationId: chatLimitReminders.organizationId,
          userId: chatLimitReminders.userId,
        })
        .from(chatLimitReminders)
        .where(
          lte(
            chatLimitReminders.remindAt,
            sql`${now.toISOString()}::timestamptz`,
          ),
        ),
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
