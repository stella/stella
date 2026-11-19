import { sql } from "drizzle-orm";

import { CHAT_LIMIT_RESET_ACTIONS } from "@stll/api-contract/chat-limit-reminder";

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

const CHAT_LIMIT_RESET_ACTION_SQL_VALUES = CHAT_LIMIT_RESET_ACTIONS.map(
  (action) => sql.raw(`'${action}'`),
);

/**
 * A member asked what happens when the usage limit that stopped their chat's
 * turn on their computer resets: to hear about it, or to have the chat
 * continue. One per thread: asking again replaces it. When it is due, the
 * reminder sweep files the notification, or the limit resumer sends the
 * turn's message again (`handlers/chat/limit-reminder/limit-resume.ts`),
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
    /** What happens at `remind_at`: notify the member, or continue the chat. */
    onReset: p
      .text("on_reset", { enum: CHAT_LIMIT_RESET_ACTIONS })
      .notNull()
      .default("notify"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("chat_limit_reminders_remind_at_idx").on(table.remindAt),
    p.index("chat_limit_reminders_turn_idx").on(table.turnId),
    p
      .index("chat_limit_reminders_org_user_idx")
      .on(table.organizationId, table.userId),
    p.check(
      "chat_limit_reminders_on_reset_check",
      sql`${table.onReset} IN (${sql.join(CHAT_LIMIT_RESET_ACTION_SQL_VALUES, sql`, `)})`,
    ),
    ...chatLimitReminderPolicies(),
  ],
);
