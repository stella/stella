export const REVIEW_DECISION = ["accepted", "rejected"] as const;
export type ReviewDecision = (typeof REVIEW_DECISION)[number];

export type ReviewDecisionEvent = {
  decision: ReviewDecision | null;
  reason: string | null;
  actorId: string | null;
  at: string;
};

export type ReviewDecisionState = {
  decision: ReviewDecision | null;
  reason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
};

const OPEN_REVIEW_DECISION: ReviewDecisionState = {
  decision: null,
  reason: null,
  decidedBy: null,
  decidedAt: null,
};

/** Fold immutable decisions chronologically. Stable sorting preserves input order for ties. */
export const foldReviewDecisions = (
  events: readonly ReviewDecisionEvent[],
): ReviewDecisionState => {
  let state = OPEN_REVIEW_DECISION;
  for (const event of events.toSorted((left, right) =>
    left.at.localeCompare(right.at),
  )) {
    state =
      event.decision === null
        ? OPEN_REVIEW_DECISION
        : {
            decision: event.decision,
            reason: event.reason,
            decidedBy: event.actorId,
            decidedAt: event.at,
          };
  }
  return state;
};

export const AVT_CLAIM_REVIEW_DECISION = {
  reviewed: "accepted",
  disputed: "rejected",
} as const satisfies Record<"reviewed" | "disputed", ReviewDecision>;

export const DOCUMENT_REVIEW_FINDING_DECISION = {
  open: null,
  accepted: "accepted",
  dismissed: "rejected",
} as const satisfies Record<
  "open" | "accepted" | "dismissed",
  ReviewDecision | null
>;

export const LIST_ITEM_SOURCE_REVIEW_DECISION = {
  unverified: null,
  verified: "accepted",
  rejected: "rejected",
} as const satisfies Record<
  "unverified" | "verified" | "rejected",
  ReviewDecision | null
>;

export const LIST_ITEM_REVIEW_DECISION = {
  verified: "accepted",
  changes_requested: "rejected",
  rejected: "rejected",
} as const satisfies Record<
  "verified" | "changes_requested" | "rejected",
  ReviewDecision
>;

export const DOCX_SUGGESTION_REVIEW_DECISION = {
  pending: null,
  accepted: "accepted",
  rejected: "rejected",
} as const satisfies Record<
  "pending" | "accepted" | "rejected",
  ReviewDecision | null
>;

export const LIST_GENERATION_CANDIDATE_REVIEW_DECISION = {
  pending: null,
  accepting: null,
  accepted: "accepted",
  rejected: "rejected",
} as const satisfies Record<
  "pending" | "accepting" | "accepted" | "rejected",
  ReviewDecision | null
>;
