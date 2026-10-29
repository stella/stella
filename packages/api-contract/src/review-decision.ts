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

/** Readonly because the fold hands every open result the same object. */
export type CurrentReviewDecision = {
  readonly decision: ReviewDecision | null;
  readonly reason: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
};

const OPEN_REVIEW_DECISION: CurrentReviewDecision = {
  decision: null,
  reason: null,
  decidedBy: null,
  decidedAt: null,
};

/** An event's moment as an instant: spellings with different offsets
 *  compare by when they happened, not by how they were written. */
const instantOf = (event: ReviewDecisionEvent): Temporal.Instant => {
  // Panicking outside `match`: a throw inside its handler is rewrapped and
  // loses this message.
  const parsed = Result.try(() => Temporal.Instant.from(event.at));
  if (Result.isError(parsed)) {
    return panic(`Review decision event time is not an instant: ${event.at}`);
  }
  return parsed.value;
};

/** Fold immutable decisions chronologically. Stable sorting preserves input order for ties. */
export const foldReviewDecisions = (
  events: readonly ReviewDecisionEvent[],
): CurrentReviewDecision => {
  // Every time is read before sorting, so a lone malformed event is refused
  // too: the comparator never runs for a history of one.
  const timed = events.map((event) => ({ event, instant: instantOf(event) }));
  let state = OPEN_REVIEW_DECISION;
  for (const { event } of timed.toSorted((left, right) =>
    Temporal.Instant.compare(left.instant, right.instant),
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
