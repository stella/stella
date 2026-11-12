import { panic } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import type {
  ClaimGrade,
  ClaimOverrideState,
  ClaimRef,
  ClaimReviewAction,
  ClaimReviewEventKind,
  ClaimReviewOrigin,
  ClaimReviewStatus,
  ClaimState,
  RecheckFactChanges,
  RecordConflict,
  RecordConflictResolution,
  VerificationEvidence,
} from "@/api/lib/lists/verification/contract";
import { CLAIM_STATE } from "@/api/lib/lists/verification/contract";
import { qualifiersNeedJudgement } from "@/api/lib/lists/verification/qualifiers";
import type { ClaimQualifier } from "@/api/lib/lists/verification/qualifiers";

type ClaimReviewEvent = {
  payload: ClaimReviewAction;
  actorId: string | null;
  createdAt: Date;
};

/** A claim's current disposition: the fold of its review events. */
export type ClaimReview = {
  status: ClaimReviewStatus | null;
  /** How the current status was set; null while there is none. */
  statusOrigin: ClaimReviewOrigin | null;
  override: ClaimOverrideState | null;
  note: string;
  noteSavedAt: Date | null;
  decidedAt: Date | null;
  decidedBy: string | null;
  /** A set-aside claim a reviewer reclassified as a checkable fact. */
  reopened: boolean;
  recordConflictResolution: RecordConflictResolution | null;
  /** Facts a reviewer pointed the claim at, in the order they were linked. */
  linkedFactIds: SafeId<"entity">[];
  /** The latest re-check: the grade the claim is read with in place of the
   *  run's, which stays on the claim row. Null until one is asked for. */
  recheck: ClaimRecheck | null;
};

export type ClaimRecheck = {
  grade: ClaimGrade;
  /** The facts it was graded against, as changes to the run's. */
  facts: RecheckFactChanges;
  modelRef: string | null;
  checkedAt: Date;
  /** Who asked for it; null once their account is gone. */
  checkedBy: string | null;
  /** The facts the claim was linked to when it was graded, which the grader
   *  was pointed at. Folded from the events before it, never stored. */
  linkedFactIds: SafeId<"entity">[];
};

export const EMPTY_CLAIM_REVIEW: ClaimReview = {
  status: null,
  statusOrigin: null,
  override: null,
  note: "",
  noteSavedAt: null,
  decidedAt: null,
  decidedBy: null,
  reopened: false,
  recordConflictResolution: null,
  linkedFactIds: [],
  recheck: null,
};

const applyEvent = (
  review: ClaimReview,
  { payload, actorId, createdAt }: ClaimReviewEvent,
): ClaimReview => {
  const decided = { decidedAt: createdAt, decidedBy: actorId };
  // Decisions taken on the grade a claim is read with; whatever changes what
  // the claim is measured against withdraws them.
  const withdrawn = {
    status: null,
    statusOrigin: null,
    override: null,
  } as const;
  switch (payload.kind) {
    case "status": {
      return {
        ...review,
        ...decided,
        status: payload.status,
        statusOrigin: payload.status === null ? null : payload.origin,
      };
    }
    case "override": {
      return { ...review, ...decided, override: payload.state };
    }
    case "note": {
      // Clearing a note keeps when it was last saved: the history still says
      // a note existed, and the event row says who removed it.
      return {
        ...review,
        note: payload.note,
        noteSavedAt: payload.note === "" ? review.noteSavedAt : createdAt,
      };
    }
    // Reopening and resolving a record conflict both change what the claim is
    // measured against, so a status or override given before described a
    // claim that no longer exists and is withdrawn.
    case "reopen": {
      return { ...review, ...decided, ...withdrawn, reopened: true };
    }
    case "record-conflict": {
      return {
        ...review,
        ...decided,
        ...withdrawn,
        recordConflictResolution: payload.resolution,
      };
    }
    // A link records what the reviewer points to; it changes no verdict
    // until the claim is checked again.
    case "fact-link": {
      const others = review.linkedFactIds.filter(
        (factId) => factId !== payload.factEntityId,
      );
      return {
        ...review,
        linkedFactIds:
          payload.change === "link"
            ? [...others, payload.factEntityId]
            : others,
      };
    }
    // A re-check grades the claim afresh, so it also withdraws a reopening
    // and a record conflict's resolution: the new grade says itself whether
    // the claim is checkable and which records conflict.
    case "recheck": {
      return {
        ...review,
        ...decided,
        ...withdrawn,
        reopened: false,
        recordConflictResolution: null,
        recheck: {
          grade: payload.grade,
          facts: payload.facts,
          modelRef: payload.modelRef,
          checkedAt: createdAt,
          checkedBy: actorId,
          linkedFactIds: review.linkedFactIds,
        },
      };
    }
    default: {
      payload satisfies never;
      return panic(`Unhandled review event: ${String(payload)}`);
    }
  }
};

/**
 * Whether the claim's links changed since the grade it is read with: the
 * facts it is linked to now differ from those its latest re-check was
 * pointed at, or, never re-checked, any are linked at all (the run's grade
 * was pointed at none). Linking and unlinking change no grade; this says
 * the grade is out of date until the claim is checked again. Derived on
 * every read, never stored.
 */
export const linksChangedSinceGrade = (review: ClaimReview): boolean => {
  const graded = new Set(
    review.recheck === null ? [] : review.recheck.linkedFactIds,
  );
  return (
    graded.size !== review.linkedFactIds.length ||
    review.linkedFactIds.some((factId) => !graded.has(factId))
  );
};

/** Events must arrive in `created_at, id` order, as the index returns them. */
export const foldClaimReview = (
  events: readonly ClaimReviewEvent[],
): ClaimReview => {
  let review = EMPTY_CLAIM_REVIEW;
  for (const event of events) {
    review = applyEvent(review, event);
  }
  return review;
};

export type ClaimReviewStep<Event extends ClaimReviewEvent> = {
  event: Event;
  /** The review just before the event, and just after it. */
  before: ClaimReview;
  after: ClaimReview;
};

/**
 * Every event with the review it found and the review it left, from the
 * same fold as `foldClaimReview`: history states what changed without
 * storing a review twice. Events arrive in fold order.
 */
export const claimReviewSteps = <Event extends ClaimReviewEvent>(
  events: readonly Event[],
): ClaimReviewStep<Event>[] => {
  const steps: ClaimReviewStep<Event>[] = [];
  let review = EMPTY_CLAIM_REVIEW;
  for (const event of events) {
    const after = applyEvent(review, event);
    steps.push({ event, before: review, after });
    review = after;
  }
  return steps;
};

type ClaimReviewTarget = {
  state: ClaimState;
  recordConflict: RecordConflict | null;
};

/**
 * The grade a claim is read with: its latest re-check's, else the one its
 * run wrote. Every reader resolves a claim through this, so a re-check
 * changes what each of them sees while the claim row stays as written.
 */
export const gradeOf = <Claim extends ClaimReviewTarget>(
  claim: Claim,
  review: ClaimReview | null,
): Claim | ClaimGrade => review?.recheck?.grade ?? claim;

export type ClaimReviewEventRejection =
  | "override-on-record-conflict"
  | "reopen-checkable-claim"
  | "already-reopened"
  | "no-record-conflict"
  | "governing-fact-not-in-conflict"
  | "fact-already-linked"
  | "fact-not-linked"
  | "recheck-set-aside-claim";

/**
 * Whether the claim can be checked again. A claim set aside as not
 * verifiable is reopened first, so a reviewer has said why it is checkable.
 */
export const rejectRecheck = (
  claim: ClaimReviewTarget,
  review: ClaimReview,
): "recheck-set-aside-claim" | null =>
  gradeOf(claim, review).state === CLAIM_STATE.NOTVERIFIABLE && !review.reopened
    ? "recheck-set-aside-claim"
    : null;

/**
 * Whether an event makes sense for this claim as it currently stands. Null
 * when it does; otherwise why not, so the handler can refuse it with a reason.
 */
export const rejectReviewEvent = (
  rawClaim: ClaimReviewTarget,
  review: ClaimReview,
  payload: ClaimReviewAction,
): ClaimReviewEventRejection | null => {
  const claim = gradeOf(rawClaim, review);
  switch (payload.kind) {
    case "status":
    case "note": {
      return null;
    }
    case "override": {
      // A withheld verdict is resolved by picking a record, not overridden.
      return claim.state === CLAIM_STATE.RECORDCONFLICT &&
        payload.state !== null
        ? "override-on-record-conflict"
        : null;
    }
    case "reopen": {
      if (claim.state !== CLAIM_STATE.NOTVERIFIABLE) {
        return "reopen-checkable-claim";
      }
      return review.reopened ? "already-reopened" : null;
    }
    case "record-conflict": {
      if (claim.recordConflict === null) {
        return "no-record-conflict";
      }
      const resolution = payload.resolution;
      if (
        resolution?.kind === "governed" &&
        !claim.recordConflict.factEntityIds.includes(resolution.factEntityId)
      ) {
        return "governing-fact-not-in-conflict";
      }
      return null;
    }
    case "fact-link": {
      const linked = review.linkedFactIds.includes(payload.factEntityId);
      if (payload.change === "link") {
        return linked ? "fact-already-linked" : null;
      }
      return linked ? null : "fact-not-linked";
    }
    case "recheck": {
      return rejectRecheck(rawClaim, review);
    }
    default: {
      payload satisfies never;
      return panic(`Unhandled review event: ${String(payload)}`);
    }
  }
};

const CONFLICT_STATES: ReadonlySet<ClaimState> = new Set([
  CLAIM_STATE.CONTRADICTED,
  CLAIM_STATE.TENSION,
  CLAIM_STATE.RECORDCONFLICT,
]);

type ReviewedClaim = {
  state: ClaimState;
  refs: readonly ClaimRef[];
};

type AttentionTarget = ReviewedClaim & {
  qualifiers: readonly Pick<ClaimQualifier, "review">[];
};

/**
 * A claim needs a human when its verdict is a conflict, it rests on a fact
 * whose meaning is contested, or it carries a qualifier that asks for
 * judgement (`QUALIFIER_REVIEW`). Everything else is routine: it may be
 * accepted in bulk, and its per-claim controls stay available for the record.
 */
export const needsAttention = (
  { state, refs, qualifiers }: AttentionTarget,
  contested: ReadonlySet<SafeId<"entity">>,
): boolean =>
  state !== CLAIM_STATE.NOTVERIFIABLE &&
  (CONFLICT_STATES.has(state) ||
    refs.some((ref) => contested.has(ref.factEntityId)) ||
    qualifiersNeedJudgement(qualifiers));

/** Facts of a run's evidence whose meaning is contested. */
export const contestedFactIds = (
  evidence: VerificationEvidence,
): ReadonlySet<SafeId<"entity">> =>
  new Set(
    evidence.facts
      .filter((fact) => fact.interpretationNote !== null)
      .map((fact) => fact.factEntityId),
  );

export type ViewTarget = ReviewedClaim & {
  recordConflict: RecordConflict | null;
};

/**
 * The claim as a reviewer sees it after their own decisions: its latest
 * re-check's grade when it has one, a reopened set-aside claim is a checkable
 * fact with no coverage until re-checked, and a governed record conflict
 * takes the verdict of the governing record. An override never changes this;
 * it is an annotation beside the verdict.
 */
export const reviewedView = (
  rawClaim: ViewTarget,
  review: ClaimReview,
): ReviewedClaim => {
  const claim = gradeOf(rawClaim, review);
  if (review.reopened && claim.state === CLAIM_STATE.NOTVERIFIABLE) {
    return { state: CLAIM_STATE.NOCOVER, refs: [] };
  }
  const resolution = review.recordConflictResolution;
  if (claim.recordConflict === null || resolution?.kind !== "governed") {
    return claim;
  }
  // `.at(-1)` would read the last record, so a miss must be caught before it.
  const index = claim.recordConflict.factEntityIds.indexOf(
    resolution.factEntityId,
  );
  if (index === -1) {
    panic("A governed record conflict names a fact outside the conflict");
  }
  return {
    state:
      claim.recordConflict.governingStates.at(index) ??
      panic("A record conflict has fewer verdicts than records"),
    refs: claim.refs,
  };
};

/**
 * The review event kinds `reviewedView` reads: reopening, resolving a record
 * conflict and re-checking. Statuses, overrides, notes and fact links leave
 * every field it reads as they were, so a reader that needs only the
 * reviewed state of many claims folds just these.
 */
export const REVIEWED_VIEW_EVENT_KINDS = [
  "reopen",
  "record-conflict",
  "recheck",
] as const satisfies readonly ClaimReviewEventKind[];

/** Where a claim stood with its reviewers at one point of its history: the
 *  verdict as they see it, their override beside it, and the status. */
export type ClaimDisposition = {
  verdict: ClaimState;
  override: ClaimOverrideState | null;
  status: ClaimReviewStatus | null;
};

export const claimDisposition = (
  claim: ViewTarget,
  review: ClaimReview,
): ClaimDisposition => ({
  verdict: reviewedView(claim, review).state,
  override: review.override,
  status: review.status,
});
