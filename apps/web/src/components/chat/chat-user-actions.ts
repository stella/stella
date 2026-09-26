import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import { hasRunningToolCallInLatestAssistantMessage } from "@/components/chat/chat-ui-tools";
import type { useChatSession } from "@/features/chat/hooks/use-chat-session";

/**
 * Where a chat action takes effect: a handler of the thread's session, a
 * request of its own, or state local to the page.
 */
type ChatUserActionTarget =
  | { handler: ChatSessionHandler; via: "session" }
  | { via: "page" }
  | { via: "request" };

type ChatSession = ReturnType<typeof useChatSession>;

/** The session's members a control calls. */
type ChatSessionHandler = {
  [K in keyof ChatSession]-?: ChatSession[K] extends (
    ...args: never[]
  ) => unknown
    ? K
    : never;
}[keyof ChatSession];

/**
 * Every action the chat thread page offers its user. The conversation
 * property test (`apps/api/src/handlers/chat/live-reload-parity.integration.test.ts`)
 * maps each one to the commands that perform it, and the rendered replay of
 * recorded conversations (`recorded-conversations.dom.test.tsx`) to the
 * recorded steps that perform it; both fail on an action they do not map.
 */
export const CHAT_USER_ACTIONS = {
  "allow-in-conversation": {
    handler: "handleAllowInConversation",
    via: "session",
  },
  "allow-once": { handler: "handleApprove", via: "session" },
  "always-allow": { handler: "handleAlwaysAllow", via: "session" },
  "answer-question": { handler: "handleAskUserSubmit", via: "session" },
  "attach-files": { via: "page" },
  copy: { via: "page" },
  "delete-thread": { via: "request" },
  deny: { handler: "handleDeny", via: "session" },
  "edit-answer": { handler: "handleAskUserEditAndRerun", via: "session" },
  export: { via: "page" },
  fork: { via: "request" },
  "improve-prompt": { via: "page" },
  "load-older": { handler: "loadOlder", via: "session" },
  "move-to-side": { via: "page" },
  /** Leaves the thread: its request closes, and its turn is not stopped. */
  "new-chat": { handler: "leave", via: "session" },
  "open-created-document": {
    handler: "handleOpenCreatedDocument",
    via: "session",
  },
  "open-draft": { handler: "handleOpenCreateDocumentDraft", via: "session" },
  "remove-queued-message": { handler: "removeQueuedMessage", via: "session" },
  "rename-thread": { via: "request" },
  /** The error's resend after the anonymization boundary refused a turn. */
  "resend-without-anonymization": {
    handler: "resendLatestMessage",
    via: "session",
  },
  "resolve-draft": { handler: "handleCreateDocumentResolve", via: "session" },
  retry: { handler: "resendLatestMessage", via: "session" },
  "run-client-tool": { handler: "addToolResult", via: "session" },
  "select-matters": { via: "page" },
  "select-model": { via: "request" },
  send: { handler: "sendMessage", via: "session" },
  stop: { handler: "stop", via: "session" },
  "toggle-anonymization": { via: "page" },
  "toggle-web-search": { via: "request" },
} as const satisfies Record<string, ChatUserActionTarget>;

export type ChatUserAction = keyof typeof CHAT_USER_ACTIONS;

/** The session handlers no action names; a new handler lands here until an
 *  action names it (`chat-user-actions.test.ts` requires this to be empty). */
export type UnnamedChatSessionHandler = Exclude<
  ChatSessionHandler,
  Extract<
    (typeof CHAT_USER_ACTIONS)[ChatUserAction],
    { via: "session" }
  >["handler"]
>;

/**
 * Whether a turn is running, which turns Send into Stop and queues a sent
 * message: a request in flight or starting, or a tool the page still runs on
 * the latest answer. A failed turn is not running.
 */
export const isChatTurnGenerating = ({
  hasError,
  messages,
  requestActive,
  sessionGenerating,
}: {
  hasError: boolean;
  messages: readonly PersistedChatMessage[];
  requestActive: boolean;
  /** A send the session has started and TanStack has not yet taken up. */
  sessionGenerating: boolean;
}): boolean =>
  !hasError &&
  (requestActive ||
    sessionGenerating ||
    hasRunningToolCallInLatestAssistantMessage({ messages }));

type AssistantMessageActionState = {
  isGenerating: boolean;
  messageId: string;
  messages: readonly PersistedChatMessage[];
};

const isLatestAssistantMessage = ({
  messageId,
  messages,
}: Omit<AssistantMessageActionState, "isGenerating">): boolean => {
  const latest = messages.at(-1);
  return latest?.role === "assistant" && latest.id === messageId;
};

/** Retry regenerates the latest answer, once no turn runs. */
export const canRetryAssistantMessage = ({
  isGenerating,
  ...message
}: AssistantMessageActionState): boolean =>
  !isGenerating && isLatestAssistantMessage(message);

/**
 * Forking reads persisted history, so it is offered on every settled answer
 * rather than only the latest: unlike retry, it neither replaces nor discards
 * anything in this thread. Only answers carry it: a fork branches off an
 * answer, and the server rejects any other boundary.
 */
export const canForkAssistantMessage = ({
  isGenerating,
  ...message
}: AssistantMessageActionState): boolean =>
  !isGenerating || !isLatestAssistantMessage(message);
