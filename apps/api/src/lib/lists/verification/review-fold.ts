import { panic } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import type {
  ClaimOverrideState,
  ClaimRef,
  ClaimReviewEventPayload,
  ClaimReviewOrigin,
  ClaimReviewStatus,
  ClaimState,
  RecordConflict,
  RecordConflictResolution,
  VerificationEvidence,
} from "@/api/lib/lists/verification/contract";
import { CLAIM_STATE } from "@/api/lib/lists/verification/contract";

type ClaimReviewEvent = {
  payload: ClaimReviewEventPayload;
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
};

const applyEvent = (
  review: ClaimReview,
  { payload, actorId, createdAt }: ClaimReviewEvent,
): ClaimReview => {
  const decided = { decidedAt: createdAt, decidedBy: actorId };
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
      return {
        ...review,
        ...decided,
        reopened: true,
        status: null,
        statusOrigin: null,
        override: null,
      };
    }
    case "record-conflict": {
      return {
        ...review,
        ...decided,
        recordConflictResolution: payload.resolution,
        status: null,
        statusOrigin: null,
        override: null,
      };
    }
    default: {
      payload satisfies never;
      return panic(`Unhandled review event: ${String(payload)}`);
    }
  }
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

type ClaimReviewTarget = {
  state: ClaimState;
  recordConflict: RecordConflict | null;
};

export type ClaimReviewEventRejection =
  | "override-on-record-conflict"
  | "reopen-checkable-claim"
  | "already-reopened"
  | "no-record-conflict"
  | "governing-fact-not-in-conflict";

/**
 * Whether an event makes sense for this claim as it currently stands. Null
 * when it does; otherwise why not, so the handler can refuse it with a reason.
 */
export const rejectReviewEvent = (
  claim: ClaimReviewTarget,
  review: ClaimReview,
  payload: ClaimReviewEventPayload,
): ClaimReviewEventRejection | null => {
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

type AttentionTarget = {
  state: ClaimState;
  refs: readonly ClaimRef[];
};

/**
 * A claim needs a human when its verdict is a conflict or it rests on a fact
 * whose meaning is contested. Everything else is routine: it may be accepted
 * in bulk, and its per-claim controls stay available for the record.
 */
export const needsAttention = (
  { state, refs }: AttentionTarget,
  contested: ReadonlySet<SafeId<"entity">>,
): boolean =>
  state !== CLAIM_STATE.NOTVERIFIABLE &&
  (CONFLICT_STATES.has(state) ||
    refs.some((ref) => contested.has(ref.factEntityId)));

/** Facts of a run's evidence whose meaning is contested. */
export const contestedFactIds = (
  evidence: VerificationEvidence,
): ReadonlySet<SafeId<"entity">> =>
  new Set(
    evidence.facts
      .filter((fact) => fact.interpretationNote !== null)
      .map((fact) => fact.factEntityId),
  );

type ViewTarget = AttentionTarget & { recordConflict: RecordConflict | null };

/**
 * The claim as a reviewer sees it after their own decisions: a reopened
 * set-aside claim is a checkable fact with no coverage until re-checked, and
 * a governed record conflict takes the verdict of the governing record. An
 * override never changes this; it is an annotation beside the verdict.
 */
export const reviewedView = (
  claim: ViewTarget,
  review: ClaimReview,
): AttentionTarget => {
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
