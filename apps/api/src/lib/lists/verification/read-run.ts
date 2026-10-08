/**
 * One verification run, its claims, and each claim's current review. Shared by the
 * point read and the review-event handlers so both answer with one shape.
 *
 * Bounded by construction: the engine caps claims per run, and events are
 * folded per claim in one ordered read rather than one query per claim.
 */

import { panic } from "better-result";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  legalListClaimReviewEvents,
  legalListClaims,
  legalListVerificationBlocks,
  legalListVerificationRuns,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  ClaimState,
  ClaimVerdict,
  RecordConflict,
} from "@/api/lib/lists/verification/contract";
import { VERIFICATION_LIMITS } from "@/api/lib/lists/verification/contract";
import type { ClaimReview } from "@/api/lib/lists/verification/review-fold";
import { foldClaimReview } from "@/api/lib/lists/verification/review-fold";

export const serializeClaimReview = (review: ClaimReview) => ({
  ...review,
  noteSavedAt: review.noteSavedAt?.toISOString() ?? null,
  decidedAt: review.decidedAt?.toISOString() ?? null,
});

type ReadClaimReviewsArgs = {
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"legalListVerificationRun">;
  /** Narrow to these claims; omitted reads every claim of the run. */
  claimIds?: readonly SafeId<"legalListClaim">[];
};

type ClaimReviewRecord = {
  review: ClaimReview;
  /** Actions recorded so far, checked against the per-claim cap. */
  eventCount: number;
};

/** Current review per claim id. A claim with no events has no entry. */
export const readClaimReviews = async ({
  tx,
  workspaceId,
  runId,
  claimIds,
}: ReadClaimReviewsArgs): Promise<
  Map<SafeId<"legalListClaim">, ClaimReviewRecord>
> => {
  // Bounded by the caps the writers enforce: claims per run and actions per
  // claim.
  const claimCount = claimIds?.length ?? VERIFICATION_LIMITS.CLAIMS_PER_RUN_MAX;
  const events = await tx
    .select({
      claimId: legalListClaimReviewEvents.claimId,
      payload: legalListClaimReviewEvents.payload,
      actorId: legalListClaimReviewEvents.actorId,
      createdAt: legalListClaimReviewEvents.createdAt,
    })
    .from(legalListClaimReviewEvents)
    .where(
      and(
        eq(legalListClaimReviewEvents.workspaceId, workspaceId),
        eq(legalListClaimReviewEvents.runId, runId),
        claimIds === undefined
          ? undefined
          : inArray(legalListClaimReviewEvents.claimId, [...claimIds]),
      ),
    )
    .orderBy(
      asc(legalListClaimReviewEvents.createdAt),
      asc(legalListClaimReviewEvents.id),
    )
    .limit(claimCount * VERIFICATION_LIMITS.REVIEW_EVENTS_PER_CLAIM_MAX);

  const byClaim = new Map<
    SafeId<"legalListClaim">,
    (typeof events)[number][]
  >();
  for (const event of events) {
    const bucket = byClaim.get(event.claimId);
    if (bucket === undefined) {
      byClaim.set(event.claimId, [event]);
    } else {
      bucket.push(event);
    }
  }
  const reviews = new Map<SafeId<"legalListClaim">, ClaimReviewRecord>();
  for (const [claimId, claimEvents] of byClaim) {
    reviews.set(claimId, {
      review: foldClaimReview(claimEvents),
      eventCount: claimEvents.length,
    });
  }
  return reviews;
};

type ClaimVerdictColumns = {
  state: ClaimState;
  score: number | null;
  recordConflict: RecordConflict | null;
};

/**
 * The verdict columns as the union the schema's CHECKs guarantee, so readers
 * narrow on `state` instead of re-checking which fields accompany it. A row
 * that breaks the pairing got past the database and is a bug, not input.
 */
const toClaimVerdict = ({
  state,
  score,
  recordConflict,
}: ClaimVerdictColumns): ClaimVerdict => {
  switch (state) {
    case "supported":
    case "tension":
    case "contradicted": {
      return {
        state,
        score: score ?? panic(`Scored claim state ${state} has no score`),
        recordConflict: null,
      };
    }
    case "nocover":
    case "notverifiable": {
      return { state, score: null, recordConflict: null };
    }
    case "recordconflict": {
      return {
        state,
        score: null,
        recordConflict:
          recordConflict ?? panic("Record-conflict claim has no conflict"),
      };
    }
    default: {
      state satisfies never;
      return panic(`Unhandled claim state: ${String(state)}`);
    }
  }
};

type ReadVerificationRunArgs = {
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"legalListVerificationRun">;
};

/** `null` when the workspace holds no such run. */
export const readVerificationRun = async ({
  tx,
  workspaceId,
  runId,
}: ReadVerificationRunArgs) => {
  const run = (
    await tx
      .select()
      .from(legalListVerificationRuns)
      .where(
        and(
          eq(legalListVerificationRuns.id, runId),
          eq(legalListVerificationRuns.workspaceId, workspaceId),
        ),
      )
      .limit(1)
  ).at(0);
  if (run === undefined) {
    return null;
  }
  const claims = await tx
    .select()
    .from(legalListClaims)
    .where(
      and(
        eq(legalListClaims.workspaceId, workspaceId),
        eq(legalListClaims.runId, runId),
      ),
    )
    .orderBy(asc(legalListClaims.position))
    .limit(VERIFICATION_LIMITS.CLAIMS_PER_RUN_MAX);
  const blocks = await tx
    .select({
      ordinal: legalListVerificationBlocks.ordinal,
      blockId: legalListVerificationBlocks.blockId,
      kind: legalListVerificationBlocks.kind,
      pageNumber: legalListVerificationBlocks.pageNumber,
      text: legalListVerificationBlocks.text,
    })
    .from(legalListVerificationBlocks)
    .where(
      and(
        eq(legalListVerificationBlocks.workspaceId, workspaceId),
        eq(legalListVerificationBlocks.runId, runId),
      ),
    )
    .orderBy(asc(legalListVerificationBlocks.ordinal))
    .limit(VERIFICATION_LIMITS.BLOCKS_PER_RUN_MAX);
  const reviews = await readClaimReviews({ tx, workspaceId, runId });
  const reviewOf = (claimId: SafeId<"legalListClaim">) => {
    const record = reviews.get(claimId);
    return record === undefined ? null : serializeClaimReview(record.review);
  };

  return {
    id: run.id,
    entityId: run.entityId,
    fileFieldId: run.fileFieldId,
    entityVersionId: run.entityVersionId,
    evidence: run.evidence,
    status: run.status,
    errorCode: run.errorCode,
    pipelineVersion: run.pipelineVersion,
    modelRef: run.modelRef,
    requestedBy: run.requestedBy,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    blocks,
    claims: claims.map((claim) => ({
      id: claim.id,
      position: claim.position,
      type: claim.type,
      framing: claim.framing,
      verdict: toClaimVerdict(claim),
      text: claim.text,
      anchor: claim.anchor,
      refs: claim.refs,
      review: reviewOf(claim.id),
    })),
  };
};

type ReadClaimForReviewArgs = {
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"legalListVerificationRun">;
  claimId: SafeId<"legalListClaim">;
};

export const readClaimForReview = async ({
  tx,
  workspaceId,
  runId,
  claimId,
}: ReadClaimForReviewArgs) =>
  // Locking the claim serializes reviewers on it, so the fold the event
  // is validated against is the one it will be appended to.
  (
    await tx
      .select({
        state: legalListClaims.state,
        recordConflict: legalListClaims.recordConflict,
      })
      .from(legalListClaims)
      .where(
        and(
          eq(legalListClaims.id, claimId),
          eq(legalListClaims.runId, runId),
          eq(legalListClaims.workspaceId, workspaceId),
        ),
      )
      .limit(1)
      .for("update")
  ).at(0);

type ReadClaimsForBulkReviewArgs = {
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"legalListVerificationRun">;
  claimIds: SafeId<"legalListClaim">[];
};

export const readClaimsForBulkReview = ({
  tx,
  workspaceId,
  runId,
  claimIds,
}: ReadClaimsForBulkReviewArgs) =>
  // Id order is the lock order every caller shares, so two overlapping
  // bulk accepts cannot deadlock.
  tx
    .select({
      id: legalListClaims.id,
      state: legalListClaims.state,
      refs: legalListClaims.refs,
      recordConflict: legalListClaims.recordConflict,
    })
    .from(legalListClaims)
    .where(
      and(
        eq(legalListClaims.workspaceId, workspaceId),
        eq(legalListClaims.runId, runId),
        inArray(legalListClaims.id, claimIds),
      ),
    )
    .orderBy(asc(legalListClaims.id))
    .limit(claimIds.length)
    .for("update");
