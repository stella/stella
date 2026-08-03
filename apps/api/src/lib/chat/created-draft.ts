import { chatMessageFromPersisted } from "@/api/handlers/chat/chat-message-parts";

type PersistedChatMessageInput = Parameters<typeof chatMessageFromPersisted>[0];

export const isReadyGeneratedDocumentDraft = ({
  content,
  fileName,
  toolCallId,
}: {
  content: PersistedChatMessageInput;
  fileName: string;
  toolCallId: string;
}): boolean =>
  chatMessageFromPersisted(content).parts.some(
    (part) =>
      part.type === "tool-call" &&
      part.name === "create-document" &&
      part.id === toolCallId &&
      part.state === "complete" &&
      part.output?.success === true &&
      "destination" in part.output &&
      part.output.destination === "draft" &&
      part.output.fileName === fileName,
  );
