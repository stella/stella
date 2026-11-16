import type { ChatPersistedState, UIMessage } from "@tanstack/ai-client";

import { chatLocalRunFilePartsOf } from "@stll/api-contract/chat-run-target";

import type {
  ChatClientTools,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";

type ChatMessagesState = Pick<ChatPersistedState<ChatClientTools>, "messages">;

/** The SDK applies an async persistence read in a later microtask. Read the
 * page's held transcript at that application boundary, not at probe completion. */
export const withCurrentChatMessages = <State extends ChatMessagesState>(
  state: State,
  readMessages: () => PersistedChatMessage[],
): Omit<State, "messages"> & ChatMessagesState => ({
  ...state,
  get messages() {
    return readMessages();
  },
});

type ClientPart = UIMessage<ChatClientTools>["parts"][number];

const isBlankText = (part: ClientPart): boolean =>
  part.type === "text" && part.content.trim().length === 0;

/**
 * A file a local run handed back rides the live stream as the answer's
 * metadata and is stored as a part. The page reads parts only, so the chip is
 * the same one live, on a rejoin and after a reload.
 */
const withLocalRunFileParts = (
  message: PersistedChatMessage,
): PersistedChatMessage => {
  if (message.role !== "assistant") {
    return message;
  }
  const files = chatLocalRunFilePartsOf(message.metadata, message.parts);
  return files.length === 0
    ? message
    : { ...message, parts: [...message.parts, ...files] };
};

const withoutDroppedParts = (
  message: UIMessage<ChatClientTools>,
  isDropped: (part: ClientPart) => boolean,
): PersistedChatMessage => {
  if (message.role !== "assistant" || !message.parts.some(isDropped)) {
    return message;
  }
  // RUN_ERROR can leave whitespace parts that server finalization drops.
  return {
    ...message,
    parts: message.parts.filter((part) => !isDropped(part)),
  };
};

/** One client message as the page holds it, computed afresh. */
export const toPersistedChatMessage = (
  message: UIMessage<ChatClientTools>,
): PersistedChatMessage =>
  withLocalRunFileParts(withoutDroppedParts(message, isBlankText));

/**
 * The client never changes a message or part object in place: it replaces
 * the object. Each projection is therefore remembered per object. A message
 * the client hands back unchanged keeps its page message, so memoized rows
 * skip it; a message the client rebuilt around the same parts (a tool
 * result, an approval, a snapshot) costs one lookup per part and reads none.
 */
const droppedByPart = new WeakMap<ClientPart, boolean>();

const isDroppedPart = (part: ClientPart): boolean => {
  const known = droppedByPart.get(part);
  if (known !== undefined) {
    return known;
  }
  const dropped = isBlankText(part);
  droppedByPart.set(part, dropped);
  return dropped;
};

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
    const persisted = withLocalRunFileParts(
      withoutDroppedParts(message, isDroppedPart),
    );
    persistedByClientMessage.set(message, persisted);
    return persisted;
  });
