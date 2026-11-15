/**
 * A member's request to hear when the usage limit that stopped their chat's
 * latest turn on their computer resets. The server reads the time off that
 * turn; the client only asks, cancels and shows it.
 */
export type ChatLimitReminderResponse = {
  /** When the member will be notified (ISO 8601); null when not asked. */
  remindAt: string | null;
};

/** Why a reminder could not be set: the chat is not waiting on a limit. */
export const CHAT_LIMIT_REMINDER_UNAVAILABLE =
  "chat_limit_reminder_unavailable" as const;
