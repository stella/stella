import type { UIMessage } from "@tanstack/ai-client";

import type {
  ChatClientTools,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";

const isBlankText = (part: UIMessage<ChatClientTools>["parts"][number]) =>
  part.type === "text" && part.content.trim().length === 0;

const toPersistedChatMessage = (
  message: UIMessage<ChatClientTools>,
): PersistedChatMessage => {
  if (message.role !== "assistant" || !message.parts.some(isBlankText)) {
    return message;
  }
  // RUN_ERROR can leave whitespace parts that server finalization drops.
  return {
    ...message,
    parts: message.parts.filter((part) => !isBlankText(part)),
  };
};

/**
 * The page's message for every client message object. The client replaces a
 * message object whenever the message changes, so a message it hands back
 * unchanged keeps its page message: memoized rows skip it, and a streamed
 * chunk costs the messages it changed rather than the whole transcript.
 */
const persistedByClientMessage = new WeakMap<
  UIMessage<ChatClientTools>,
  PersistedChatMessage
>();

export const toPersistedChatMessages = (
  messages: readonly UIMessage<ChatClientTools>[],
): PersistedChatMessage[] =>
  messages.map((message) => {
    const known = persistedByClientMessage.get(message);
    if (known !== undefined) {
      return known;
    }
    const persisted = toPersistedChatMessage(message);
    persistedByClientMessage.set(message, persisted);
    return persisted;
  });
