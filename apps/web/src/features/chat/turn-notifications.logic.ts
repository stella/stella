import { panic } from "better-result";

/** Where a thread's turn stands, as far as the user is concerned. */
export type ChatTurnPhase = "awaiting-user" | "failed" | "idle" | "running";

/** Why a hidden page tells the user about their chat. */
export type ChatTurnNotificationKind = "failed" | "needs-input" | "reply-ready";

/** The browser's per-device opt-in; "1" when on. */
export const CHAT_TURN_NOTIFICATIONS_STORAGE_KEY =
  "stella:chat-turn-notifications";

export const getChatTurnPhase = ({
  awaitingUser,
  hasError,
  isGenerating,
}: {
  awaitingUser: boolean;
  hasError: boolean;
  isGenerating: boolean;
}): ChatTurnPhase => {
  if (isGenerating) {
    return "running";
  }
  if (hasError) {
    return "failed";
  }
  return awaitingUser ? "awaiting-user" : "idle";
};

/**
 * The notification a phase change calls for. Only the end of a turn this
 * page watched run notifies (a thread opened already settled never does),
 * and only while the page is out of sight: a user looking at the chat
 * already sees it.
 */
export const getChatTurnNotification = ({
  current,
  pageVisible,
  previous,
}: {
  current: ChatTurnPhase;
  pageVisible: boolean;
  previous: ChatTurnPhase | null;
}): ChatTurnNotificationKind | null => {
  if (previous !== "running" || pageVisible) {
    return null;
  }
  switch (current) {
    case "running":
      return null;
    case "awaiting-user":
      return "needs-input";
    case "failed":
      return "failed";
    case "idle":
      return "reply-ready";
    default:
      current satisfies never;
      return panic("Unhandled chat turn phase");
  }
};
