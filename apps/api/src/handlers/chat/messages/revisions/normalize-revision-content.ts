import { normalizePersistedChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import type { PersistedChatMessageContent } from "@/api/handlers/chat/types";

export const normalizeRevisionContent = (
  stored: PersistedChatMessageContent,
) => ({
  normalized: normalizePersistedChatMessageContent(stored),
  content: stored,
});
