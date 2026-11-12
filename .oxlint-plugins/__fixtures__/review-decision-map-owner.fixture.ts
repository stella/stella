// Passive regression fixture for
// `review-decision-map-owner/review-decision-map-owner`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import {
  REVIEW_STATUS_DECISION,
  type ReviewDecision,
} from "@stll/api-contract/review-decision";

type Status = "reviewed" | "disputed";

// --- Flagged: a second status-to-decision map ---
export const SECOND_MAP = {
  reviewed: "accepted",
  disputed: "rejected",
  // oxlint-disable-next-line review-decision-map-owner/review-decision-map-owner
} as const satisfies Record<Status, ReviewDecision | null>;

// oxlint-disable-next-line review-decision-map-owner/review-decision-map-owner
export type DecisionByStatus = Record<Status, ReviewDecision>;

// --- Allowed: reading the owner, and records of other values ---
// expect-clean: review-decision-map-owner/review-decision-map-owner
export const decisionOf = (status: Status) => REVIEW_STATUS_DECISION.claim[status];

export const LABELS = {
  reviewed: "Reviewed",
  disputed: "Disputed",
} as const satisfies Record<Status, string>;
