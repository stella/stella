import { chatMessageFromPersisted } from "@/api/handlers/chat/chat-message-parts";
import type {
  ChatMessageRole,
  PersistableChatMessage,
  PersistedChatMessageContent,
} from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";

type PlanMessagePersistenceProps = {
  message: PersistableChatMessage;
  storedMessages: {
    id: SafeId<"chatMessage">;
    role: ChatMessageRole;
    content: PersistedChatMessageContent;
  }[];
  /**
   * The incoming message already exists for this thread per a targeted DB
   * check. `storedMessages` may be a bounded window that excludes an old
   * re-sent/edited id, so a window miss must not be treated as "new" and
   * drive a duplicate insert. Defaults to false (in-window behaviour).
   */
  incomingMessageExists?: boolean;
};

export type MessagePersistencePlan =
  | { type: "none" }
  | { type: "insert"; message: PersistableChatMessage }
  | {
      message: PersistableChatMessage;
      messageId: SafeId<"chatMessage">;
      type: "update";
    }
  | {
      deleteMessageId: SafeId<"chatMessage">;
      insertMessage: PersistableChatMessage;
      type: "replace-last-assistant";
    };

type PlanMessagePersistenceResult = {
  existingIds: Set<SafeId<"chatMessage">>;
  messages: PersistableChatMessage[];
  persistencePlan: MessagePersistencePlan;
};

export const planMessagePersistence = ({
  message,
  storedMessages,
  incomingMessageExists = false,
}: PlanMessagePersistenceProps): PlanMessagePersistenceResult => {
  const existingIds = new Set(storedMessages.map((m) => m.id));
  const messages = storedMessages.map(chatMessageFromPersisted);

  // The id exists in this thread but falls outside the (possibly windowed)
  // `storedMessages`. The window cannot reconcile such a message in-memory, so
  // skip persistence rather than insert a duplicate (PK violation) or update a
  // row we never loaded.
  if (incomingMessageExists && !existingIds.has(message.id)) {
    return {
      messages,
      existingIds,
      persistencePlan: { type: "none" },
    };
  }

  if (message.role === "user") {
    if (existingIds.has(message.id)) {
      return {
        messages,
        existingIds,
        persistencePlan: { type: "none" },
      };
    }

    messages.push(message);
    existingIds.add(message.id);

    return {
      messages,
      existingIds,
      persistencePlan: { type: "insert", message },
    };
  }

  if (message.role !== "assistant") {
    return {
      messages,
      existingIds,
      persistencePlan: { type: "none" },
    };
  }

  const existingIndex = messages.findIndex(
    (storedMessage) => storedMessage.id === message.id,
  );

  if (existingIndex !== -1) {
    messages[existingIndex] = message;

    return {
      messages,
      existingIds,
      persistencePlan: {
        type: "update",
        messageId: message.id,
        message,
      },
    };
  }

  const lastMessage = messages.at(-1);
  if (lastMessage?.role === "assistant") {
    messages[messages.length - 1] = message;
    existingIds.delete(lastMessage.id);
    existingIds.add(message.id);

    return {
      messages,
      existingIds,
      persistencePlan: {
        type: "replace-last-assistant",
        deleteMessageId: lastMessage.id,
        insertMessage: message,
      },
    };
  }

  messages.push(message);
  existingIds.add(message.id);

  return {
    messages,
    existingIds,
    persistencePlan: { type: "insert", message },
  };
};

/**
 * Why the assistant streaming turn finished, from the streaming loop's point of
 * view. Only a fully completed generation is persisted; a generation cut off
 * mid-stream (metered-timeout abort, aborted-stream finish) leaves an
 * incomplete message that must be discarded.
 *
 * This is deliberately independent of the client HTTP connection. The metered
 * provider call is decoupled from the socket (see `createMeteredAIAbortSignal`),
 * so a dropped connection does not make the generation "aborted": the message is
 * still fully generated and metered, and must be persisted. Modelling the finish
 * reason as an outcome rather than a bare `isAborted` boolean keeps a future
 * caller from folding connection state back into the persistence decision.
 */
export type ChatAssistantFinishOutcome =
  | { type: "completed" }
  | { type: "aborted" };

type PlanAssistantFinishPersistenceProps = {
  existingIds: Set<SafeId<"chatMessage">>;
  finishOutcome: ChatAssistantFinishOutcome;
  message: PersistableChatMessage;
};

export const planAssistantFinishPersistence = ({
  existingIds,
  finishOutcome,
  message,
}: PlanAssistantFinishPersistenceProps): MessagePersistencePlan => {
  if (message.role !== "assistant") {
    return { type: "none" };
  }

  switch (finishOutcome.type) {
    case "aborted":
      return { type: "none" };
    case "completed":
      return existingIds.has(message.id)
        ? { type: "update", messageId: message.id, message }
        : { type: "insert", message };
    default:
      return finishOutcome satisfies never;
  }
};
