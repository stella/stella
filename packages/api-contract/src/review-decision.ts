import { panic, Result } from "better-result";

import { Temporal } from "@stll/time";

export const REVIEW_DECISION = ["accepted", "rejected"] as const;
export type ReviewDecision = (typeof REVIEW_DECISION)[number];

/**
 * Each review surface's own status words, read as the shared decision: the
 * one place a status becomes accepted, rejected or open (null). A verified
 * claim marked `needs-evidence` stays open until the record can answer it;
 * a finding is born `open`; a list item sent back for changes is rejected.
 * Every reader (AVT's review fold, a finding's decision history, its trigger
 * and backfill, a source's history, the browser's queue) reads through this
 * map. A lint bans a second one (`review-decision-map-owner`), and a
 * Postgres test pins the finding trigger's SQL to it.
 */
export const REVIEW_STATUS_DECISION = {
  /** A verified claim's review status (AVT). */
  claim: {
    reviewed: "accepted",
    disputed: "rejected",
    "needs-evidence": null,
  },
  /** A document review finding's decision. */
  finding: {
    open: null,
    accepted: "accepted",
    dismissed: "rejected",
  },
  /** An AI DOCX suggestion's status. */
  docxSuggestion: {
    pending: null,
    accepted: "accepted",
    rejected: "rejected",
  },
  /** A list item's review decision. */
  listItem: {
    verified: "accepted",
    changes_requested: "rejected",
    rejected: "rejected",
  },
  /** A list item source's verification status. */
  listItemSource: {
    unverified: null,
    verified: "accepted",
    rejected: "rejected",
  },
  /** A generated list candidate's status. */
  listGenerationCandidate: {
    pending: null,
    accepting: null,
    accepted: "accepted",
    rejected: "rejected",
  },
} as const satisfies Record<string, Record<string, ReviewDecision | null>>;

type ReviewSurface = keyof typeof REVIEW_STATUS_DECISION;

/**
 * `true` when a surface's map reads exactly `Status`. Each surface asserts
 * it where its statuses are declared (`true satisfies ReadsExactly<…>`), so
 * a status the map lacks, or one it reads that no longer exists, fails to
 * compile there.
 */
export type ReadsExactly<
  Surface extends ReviewSurface,
  Status extends string,
> = [keyof (typeof REVIEW_STATUS_DECISION)[Surface]] extends [Status]
  ? [Status] extends [keyof (typeof REVIEW_STATUS_DECISION)[Surface]]
    ? true
    : false
  : false;

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
