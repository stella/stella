import { normalizeLegacyToolInputs } from "@/api/handlers/chat/legacy-tool-compat";
import type {
  ChatMessage,
  ChatMessageContent,
  ChatMessageRole,
} from "@/api/handlers/chat/types";

type PlanMessagePersistenceProps = {
  message: ChatMessage;
  storedMessages: {
    id: string;
    role: ChatMessageRole;
    content: ChatMessageContent;
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
  | { type: "insert"; message: ChatMessage }
  | { message: ChatMessage; messageId: string; type: "update" }
  | {
      deleteMessageId: string;
      insertMessage: ChatMessage;
      type: "replace-last-assistant";
    };

type PlanMessagePersistenceResult = {
  existingIds: Set<string>;
  messages: ChatMessage[];
  persistencePlan: MessagePersistencePlan;
};

export const planMessagePersistence = ({
  message,
  storedMessages,
  incomingMessageExists = false,
}: PlanMessagePersistenceProps): PlanMessagePersistenceResult => {
  const existingIds = new Set(storedMessages.map((m) => m.id));
  const messages = storedMessages.map((m) => ({
    id: m.id,
    role: m.role,
    parts: normalizeLegacyToolInputs(m.content.data),
  }));

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

type PlanAssistantFinishPersistenceProps = {
  existingIds: Set<string>;
  isAborted: boolean;
  message: ChatMessage;
};

export const planAssistantFinishPersistence = ({
  existingIds,
  isAborted,
  message,
}: PlanAssistantFinishPersistenceProps): MessagePersistencePlan => {
  if (isAborted || message.role !== "assistant") {
    return { type: "none" };
  }

  if (existingIds.has(message.id)) {
    return {
      type: "update",
      messageId: message.id,
      message,
    };
  }

  return { type: "insert", message };
};
