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
