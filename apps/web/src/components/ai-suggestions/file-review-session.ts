import { panic } from "better-result";

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
      context satisfies never;
      return panic(`Unhandled context: ${String(context)}`);
    }
  }
};
