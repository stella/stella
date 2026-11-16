import { chatThreads, chatTurns } from "./chat";
import {
  chatLimitReminderPolicies,
  organization,
  p,
  safeOrganizationId,
  safeUuid,
  timestamptz,
  user,
} from "./common";

/**
 * A member asked to hear when the usage limit that stopped their chat's turn
 * on their computer resets. One per thread: asking again moves the time. The
 * reminder sweep deletes the row when it is due and files the notification,
 * unless a newer turn already continued the chat.
 */
export const chatLimitReminders = p.pgTable(
  "chat_limit_reminders",
  {
    threadId: safeUuid<"chatThread">("thread_id")
      .primaryKey()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    /** The failed turn the reminder is for; a newer turn makes it moot. */
    turnId: safeUuid<"chatTurn">("turn_id")
      .notNull()
      .references(() => chatTurns.id, { onDelete: "cascade" }),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** When the harness said its limit resets. */
    remindAt: timestamptz("remind_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("chat_limit_reminders_remind_at_idx").on(table.remindAt),
    p.index("chat_limit_reminders_turn_idx").on(table.turnId),
    p
      .index("chat_limit_reminders_org_user_idx")
      .on(table.organizationId, table.userId),
    ...chatLimitReminderPolicies(),
  ],
);
