import { panic, Result } from "better-result";

import { Temporal } from "@stll/time";

export const REVIEW_DECISION = ["accepted", "rejected"] as const;
export type ReviewDecision = (typeof REVIEW_DECISION)[number];

export type ReviewDecisionEvent = {
  decision: ReviewDecision | null;
  reason: string | null;
  actorId: string | null;
  at: string;
};

export type CurrentReviewDecision = {
  decision: ReviewDecision | null;
  reason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
};

const OPEN_REVIEW_DECISION: CurrentReviewDecision = {
  decision: null,
  reason: null,
  decidedBy: null,
  decidedAt: null,
};

/** An event's moment as an instant: spellings with different offsets
 *  compare by when they happened, not by how they were written. */
const instantOf = (event: ReviewDecisionEvent): Temporal.Instant =>
  Result.try(() => Temporal.Instant.from(event.at)).match({
    ok: (instant) => instant,
    err: () =>
      panic(`Review decision event time is not an instant: ${event.at}`),
  });

/** Fold immutable decisions chronologically. Stable sorting preserves input order for ties. */
export const foldReviewDecisions = (
  events: readonly ReviewDecisionEvent[],
): CurrentReviewDecision => {
  let state = OPEN_REVIEW_DECISION;
  for (const event of events.toSorted((left, right) =>
    Temporal.Instant.compare(instantOf(left), instantOf(right)),
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
