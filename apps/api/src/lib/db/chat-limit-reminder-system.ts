import { and, asc, eq, lte, not, or, sql } from "drizzle-orm";

import { CHAT_LIMIT_RESET_ACTION } from "@stll/api-contract/chat-limit-reminder";

import { chatLimitReminders } from "@/api/db/schema";
import type { Transaction } from "@/api/db/types";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * The limit reminders' reads and writes that no member's connection can
 * make: which reminders are due across every organization, and dropping a
 * request of a member who can no longer act. Crosses organizations by
 * design, as the queue sender does; it reads ids, owners and times only,
 * never chat content. The scheduler's reminder sweep and the owner
 * connection's doors in `db/root.ts` run these.
 */

/**
 * How long after the reset a request to continue the chat is tried before
 * the member is notified instead. A computer reports a harness's usage
 * limit again only on its next check (every 5 minutes), so a limit that has
 * just reset can still read as reached for that long; twice that covers it
 * and a missed sweep. Past it, the reminder sweep notifies.
 */
export const CHAT_LIMIT_RESUME_WINDOW_MS = 10 * 60 * 1000;

/** A reminder that is due, and whose it is. */
export type DueChatLimitReminder = {
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
  organizationId: SafeId<"organization">;
  userId: string;
};

/** The columns that say which reminder is due and whose it is. */
export const DUE_CHAT_LIMIT_REMINDER_COLUMNS = {
  threadId: chatLimitReminders.threadId,
  turnId: chatLimitReminders.turnId,
  organizationId: chatLimitReminders.organizationId,
  userId: chatLimitReminders.userId,
} as const;

/** `remind_at` at or before `now`. */
const dueBy = (now: Date) =>
  lte(chatLimitReminders.remindAt, sql`${now.toISOString()}::timestamptz`);

/**
 * `remind_at` more than the resume window before `now`. The window is added
 * to the column, so `now` stays the full-precision instant `dueBy` reads.
 */
const windowPassedBy = (now: Date) =>
  sql<boolean>`${chatLimitReminders.remindAt} + ${CHAT_LIMIT_RESUME_WINDOW_MS} * interval '1 millisecond' <= ${now.toISOString()}::timestamptz`;

/**
 * The reminders the reminder sweep takes at `now`: every notification that is
 * due, and every request to continue whose window has passed without the
 * chat continuing.
 */
export const dueChatLimitNotificationsSelect = (tx: Transaction, now: Date) =>
  tx
    .select(DUE_CHAT_LIMIT_REMINDER_COLUMNS)
    .from(chatLimitReminders)
    .where(
      and(
        dueBy(now),
        or(
          eq(chatLimitReminders.onReset, CHAT_LIMIT_RESET_ACTION.notify),
          windowPassedBy(now),
        ),
      ),
    );

/**
 * Up to `limit` requests to continue a chat that are due at `now` and still
 * in their window, the longest due first. Nothing is marked: a request that
 * cannot start yet is tried again on the next sweep until its window ends.
 */
export const readDueChatLimitResumesOnTx = async ({
  limit,
  now,
  tx,
}: {
  limit: number;
  now: Date;
  tx: Transaction;
}): Promise<DueChatLimitReminder[]> =>
  await tx
    .select(DUE_CHAT_LIMIT_REMINDER_COLUMNS)
    .from(chatLimitReminders)
    .where(
      and(
        eq(chatLimitReminders.onReset, CHAT_LIMIT_RESET_ACTION.continue),
        dueBy(now),
        not(windowPassedBy(now)),
      ),
    )
    .orderBy(asc(chatLimitReminders.remindAt))
    .limit(limit);

/**
 * Drop the request to continue the chat after the limit that stopped
 * `turnId`: its member can no longer act there, so no connection of theirs
 * can, and nobody is told.
 */
export const discardChatLimitResumeOnTx = async ({
  threadId,
  turnId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
  tx: Transaction;
}): Promise<void> => {
  // audit: skip — drops a request of a member who can no longer act; nothing of the chat changes
  await tx
    .delete(chatLimitReminders)
    .where(
      and(
        eq(chatLimitReminders.threadId, threadId),
        eq(chatLimitReminders.turnId, turnId),
        eq(chatLimitReminders.onReset, CHAT_LIMIT_RESET_ACTION.continue),
      ),
    );
};
