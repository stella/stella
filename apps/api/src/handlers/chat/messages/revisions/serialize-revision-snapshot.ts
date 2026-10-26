import { panic } from "better-result";

import { isUnsupportedChatPart } from "@stll/api-contract/chat";

import {
  clientVisibleStoredChatPart,
  normalizePersistedChatMessageContent,
} from "@/api/handlers/chat/chat-message-parts";
import { clientVisibleChatPart } from "@/api/handlers/chat/client-visible-chat-part";
import type { PersistedChatMessageContent } from "@/api/handlers/chat/types";

type RevisionSnapshot = Pick<
  PersistedChatMessageContent,
  "version" | "data" | "metadata"
>;

// Persistence proofs and fields from later releases stay on the server.
export const serializeRevisionSnapshot = (
  content: RevisionSnapshot,
): { version: 3; data: unknown[]; metadata?: unknown } => {
  const readParts = normalizePersistedChatMessageContent(content).parts;
  return {
    version: content.version,
    data: content.data.map((part, index) => {
      const read =
        readParts.at(index) ??
        panic("Revision snapshot projection lost a stored part");
      return isUnsupportedChatPart(read)
        ? clientVisibleChatPart(read)
        : clientVisibleStoredChatPart(part);
    }),
    ...(content.metadata === undefined ? {} : { metadata: content.metadata }),
  };
};
