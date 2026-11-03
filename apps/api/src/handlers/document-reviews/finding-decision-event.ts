import type { ReviewDecision } from "@stll/api-contract/review-decision";

import {
  DOCUMENT_REVIEW_FINDING_DECISION,
  type DocumentReviewDecision,
} from "@/api/lib/document-review/run-contract";

export const findingDecisionEvent = (
  previous: DocumentReviewDecision,
  next: DocumentReviewDecision,
): ReviewDecision | null | undefined =>
  previous === next ? undefined : DOCUMENT_REVIEW_FINDING_DECISION[next];
