import { createDocumentDraftReviewId } from "@/components/chat/create-document-draft.logic";

type FileReviewSessionContext =
  | { type: "file"; entityId: string }
  | { type: "draft"; toolCallId: string }
  | { type: "none" };

export const resolveFileReviewSessionId = (
  context: FileReviewSessionContext,
): string | undefined => {
  switch (context.type) {
    case "file":
      return context.entityId;
    case "draft":
      return createDocumentDraftReviewId(context.toolCallId);
    case "none":
      return undefined;
    default: {
      const exhaustive: never = context;
      return exhaustive;
    }
  }
};
