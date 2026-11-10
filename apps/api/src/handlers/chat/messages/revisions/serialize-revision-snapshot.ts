import { clientVisibleStoredContent } from "@/api/handlers/chat/chat-message-parts";
import type { PersistedChatMessageContent } from "@/api/handlers/chat/types";

type RevisionSnapshot = Pick<
  PersistedChatMessageContent,
  "version" | "data" | "metadata"
>;

// Persistence proofs and fields from later releases stay on the server.
export const serializeRevisionSnapshot = (
  content: RevisionSnapshot,
): { version: 3; data: unknown[]; metadata?: unknown } =>
  clientVisibleStoredContent(content);
