/**
 * What the server does when the usage limit that stopped a chat's latest turn
 * on the member's computer resets: `notify` the member, or `continue` the
 * chat by sending the stopped turn's message again, on the same computer and
 * agent. A continue that cannot start (the computer is away, the limit is
 * still reached) notifies instead, once.
 */
export const CHAT_LIMIT_RESET_ACTION = {
  notify: "notify",
  continue: "continue",
} as const;

export type ChatLimitResetAction =
  (typeof CHAT_LIMIT_RESET_ACTION)[keyof typeof CHAT_LIMIT_RESET_ACTION];

export const CHAT_LIMIT_RESET_ACTIONS = [
  CHAT_LIMIT_RESET_ACTION.notify,
  CHAT_LIMIT_RESET_ACTION.continue,
] as const satisfies readonly ChatLimitResetAction[];

/**
 * A member's request about the usage limit that stopped their chat's latest
 * turn on their computer. The server reads the time off that turn; the client
 * only asks, cancels and shows it.
 */
export type ChatLimitReminderResponse =
  /** Nothing is asked for the chat's latest turn. */
  | { remindAt: null }
  | {
      /** When the limit resets and the server acts (ISO 8601). */
      remindAt: string;
      onReset: ChatLimitResetAction;
    };

/** What a member asks for when the limit resets. */
export type ChatLimitReminderRequest = { onReset: ChatLimitResetAction };

/** Why a reminder could not be set: the chat is not waiting on a limit. */
export const CHAT_LIMIT_REMINDER_UNAVAILABLE =
  "chat_limit_reminder_unavailable" as const;
