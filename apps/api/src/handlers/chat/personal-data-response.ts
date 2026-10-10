import { panic } from "better-result";

import type {
  chatMessageRevisions,
  chatMessages,
  chatThreads,
} from "@/api/db/schema";
import { CHAT_TITLE_SOURCE } from "@/api/db/schema";
import { normalizePersistedChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import type { ChatMessageRole, ChatPart } from "@/api/handlers/chat/types";

const PERSONAL_CHAT_ROLE_POLICY = {
  user: "export",
  assistant: "exclude",
  system: "exclude",
} as const satisfies Record<ChatMessageRole, "export" | "exclude">;

// Generated titles and matter references can contain data belonging to others.
export const toPersonalChatThreadResponse = (
  row: typeof chatThreads.$inferSelect,
) => ({
  id: row.id,
  title: row.titleSource === CHAT_TITLE_SOURCE.USER ? row.title : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const personalTextParts = (part: ChatPart) => {
  switch (part.type) {
    case "text":
      return [{ type: part.type, content: part.content }];
    case "audio":
    case "document":
    case "image":
    case "structured-output":
    case "subagent":
    case "thinking":
    case "tool-call":
    case "tool-result":
    case "ui-resource":
    case "video":
      return [];
    default:
      part satisfies never;
      return panic("Unhandled personal chat part");
  }
};

// Only authored text crosses this boundary; attachments, tool results and
// message metadata can reference documents or content owned by a matter.
export const toPersonalChatMessageResponse = (
  row: typeof chatMessages.$inferSelect,
) => {
  if (PERSONAL_CHAT_ROLE_POLICY[row.role] === "exclude") {
    return null;
  }
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role,
    parts: normalizePersistedChatMessageContent(row.content).parts.flatMap(
      personalTextParts,
    ),
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
  };
};

// Revisions inherit ownership and provenance from their message and thread.
export const toPersonalChatMessageRevisionResponse = (
  row: typeof chatMessageRevisions.$inferSelect,
  role: ChatMessageRole,
) => {
  if (PERSONAL_CHAT_ROLE_POLICY[role] === "exclude") {
    return null;
  }
  return {
    id: row.id,
    messageId: row.messageId,
    threadId: row.threadId,
    revision: row.revision,
    parts: normalizePersistedChatMessageContent(row.content).parts.flatMap(
      personalTextParts,
    ),
    createdAt: row.createdAt.toISOString(),
  };
};
