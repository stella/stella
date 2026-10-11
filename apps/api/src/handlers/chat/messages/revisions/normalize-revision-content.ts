import {
  normalizePersistedChatMessageContent,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import type { PersistedChatMessageContent } from "@/api/handlers/chat/types";

// Selection proposals preserve an explicitly stored empty metadata object,
// while older snapshots without metadata remain absent after normalization.
export const normalizeRevisionContent = (
  stored: PersistedChatMessageContent,
) => {
  const normalized = normalizePersistedChatMessageContent(stored);
  const content = toPersistedChatMessageContentV3({
    data: normalized.parts,
    ...(Object.keys(normalized.metadata).length > 0 ||
    ("metadata" in stored && stored.metadata !== undefined)
      ? { metadata: normalized.metadata }
      : {}),
  });
  return { normalized, content };
};
