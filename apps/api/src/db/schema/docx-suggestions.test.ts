import { expect, test } from "bun:test";

import type { ReviewDecision } from "@stll/api-contract/review-decision";

import {
  DOCX_SUGGESTION_REVIEW_DECISION,
  type DocxSuggestionStatus,
} from "./docx-suggestions";

DOCX_SUGGESTION_REVIEW_DECISION satisfies Record<
  DocxSuggestionStatus,
  ReviewDecision | null
>;

test("suggestion statuses translate to shared decisions", () => {
  expect(DOCX_SUGGESTION_REVIEW_DECISION).toEqual({
    pending: null,
    accepted: "accepted",
    rejected: "rejected",
  });
});
