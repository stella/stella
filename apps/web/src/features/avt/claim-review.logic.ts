/**
 * Optimistic claim reviews. Every reviewer action is one POST; while it is in
 * flight the claim shows the review the server is expected to return, and the
 * server's answer replaces the prediction as soon as it lands. The prediction
 * follows the server's review fold (apps/api lib/lists/verification/
 * review-fold.ts): reopening and resolving a record conflict withdraw an
 * earlier status and override, and clearing a note keeps when one was saved.
 */

import { panic } from "better-result";

import type {
  ClaimReview,
  ClaimReviewEvent,
  VerificationClaim,
  VerificationRun,
} from "@/features/avt/types";

export const EMPTY_CLAIM_REVIEW = {
  status: null,
  statusOrigin: null,
  override: null,
  note: "",
  noteSavedAt: null,
  decidedAt: null,
  decidedBy: null,
  reopened: false,
  recordConflictResolution: null,
} as const satisfies ClaimReview;

type PredictionContext = {
  /** ISO instant the action is taken at. */
  at: string;
  actorId: string;
};

export const predictClaimReview = (
  current: ClaimReview | null,
  event: ClaimReviewEvent,
  { at, actorId }: PredictionContext,
): ClaimReview => {
  const review = current ?? EMPTY_CLAIM_REVIEW;
  const decided = { decidedAt: at, decidedBy: actorId };
  switch (event.kind) {
    case "status": {
      return {
        ...review,
        ...decided,
        status: event.status,
        statusOrigin: event.status === null ? null : "single",
      };
    }
    case "override": {
      return { ...review, ...decided, override: event.state };
    }
    case "note": {
      return {
        ...review,
        note: event.note,
        noteSavedAt: event.note === "" ? review.noteSavedAt : at,
      };
    }
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
        recordConflictResolution: event.resolution,
        status: null,
        statusOrigin: null,
        override: null,
      };
    }
    default: {
      event satisfies never;
      return panic(`Unhandled review event: ${String(event)}`);
    }
  }
};

/** Accepting routine claims in bulk marks only those nobody has decided. */
export const predictBulkReviewed = (
  current: ClaimReview | null,
  context: PredictionContext,
): ClaimReview => {
  const review = current ?? EMPTY_CLAIM_REVIEW;
  if (review.status !== null) {
    return review;
  }
  return {
    ...review,
    decidedAt: context.at,
    decidedBy: context.actorId,
    status: "reviewed",
    statusOrigin: "bulk",
  };
};

type ClaimReviewUpdate = {
  claimId: VerificationClaim["id"];
  review: ClaimReview | null;
};

/** The run with the given claims' reviews replaced; other claims untouched. */
export const withClaimReviews = (
  run: VerificationRun,
  updates: readonly ClaimReviewUpdate[],
): VerificationRun => {
  if (updates.length === 0) {
    return run;
  }
  const byClaim = new Map(
    updates.map((update) => [update.claimId, update.review]),
  );
  return {
    ...run,
    claims: run.claims.map((claim) =>
      byClaim.has(claim.id)
        ? { ...claim, review: byClaim.get(claim.id) ?? null }
        : claim,
    ),
  };
};
