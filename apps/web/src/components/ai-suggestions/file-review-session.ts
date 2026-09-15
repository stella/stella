import { panic } from "better-result";

import { createDocumentDraftReviewId } from "@/components/chat/create-document-draft.logic";

/**
 * What starting a new chat thread does with the active document's review
 * session: `keep` leaves pending suggestions in review, `dismiss` means they
 * were rejected before the rotation, `none` means nothing was pending.
 */
export const PENDING_REVIEW_CHOICE = {
  keep: "keep",
  dismiss: "dismiss",
  none: "none",
} as const;

export type PendingReviewChoice =
  (typeof PENDING_REVIEW_CHOICE)[keyof typeof PENDING_REVIEW_CHOICE];

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
