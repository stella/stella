import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import {
  type CreateDocumentDraft,
  selectCreateDocumentDrafts,
} from "@/components/chat/create-document-draft.logic";

const MARKDOWN_CITATION_PATTERN =
  /(?:\[[^\]]+\]\((?:https?:\/\/|#(?:folio|stella-))|https?:\/\/)/u;

export const hasMessageExportCitations = (
  message: PersistedChatMessage,
): boolean => {
  if ((message.metadata?.sourceDocuments?.length ?? 0) > 0) {
    return true;
  }
  return message.parts.some(
    (part) =>
      part.type === "text" && MARKDOWN_CITATION_PATTERN.test(part.content),
  );
};

export const findCreateDocumentArtifactForMessage = (
  messages: readonly PersistedChatMessage[],
  messageIndex: number,
): CreateDocumentDraft | null => {
  const message = messages.at(messageIndex);
  if (message?.role !== "assistant") {
    return null;
  }

  let turnStart = messageIndex;
  while (turnStart > 0 && messages.at(turnStart - 1)?.role !== "user") {
    turnStart -= 1;
  }

  return (
    selectCreateDocumentDrafts(messages.slice(turnStart, messageIndex + 1)).at(
      -1,
    ) ?? null
  );
};
