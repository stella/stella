/**
 * One verification run, its claims, and each claim's current review. Shared by the
 * point read and the review-event handlers so both answer with one shape.
 *
 * Bounded by construction: the engine caps claims per run, and events are
 * folded per claim in one ordered read rather than one query per claim.
 */

import { panic } from "better-result";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  legalListClaimReviewEvents,
  legalListClaims,
  legalListFactDetails,
  legalListItems,
  legalListItemSources,
  legalListVerificationBlocks,
  legalListVerificationRuns,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  ClaimState,
  ClaimVerdict,
  RecordConflict,
  VerificationEvidence,
} from "@/api/lib/lists/verification/contract";
import { VERIFICATION_LIMITS } from "@/api/lib/lists/verification/contract";
import {
  claimQualifiers,
  restingFactIds,
} from "@/api/lib/lists/verification/qualifiers";
import type { FactStanding } from "@/api/lib/lists/verification/qualifiers";
import type { ClaimReview } from "@/api/lib/lists/verification/review-fold";
import {
  contestedFactIds,
  foldClaimReview,
} from "@/api/lib/lists/verification/review-fold";

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

/** The list identity a run summary projects from its stored evidence. */
export const verificationRunListIdColumn = sql<
  SafeId<"legalList">
>`(${legalListVerificationRuns.evidence} ->> 'listId')`;

/** `null` when the workspace holds no such run. */
export const readRunEvidenceForGrading = async ({
  tx,
  workspaceId,
  runId,
}: ReadVerificationRunArgs) => {
  const run = (
    await tx
      .select({ evidence: legalListVerificationRuns.evidence })
      .from(legalListVerificationRuns)
      .where(
        and(
          eq(legalListVerificationRuns.id, runId),
          eq(legalListVerificationRuns.workspaceId, workspaceId),
        ),
      )
      .limit(1)
  ).at(0);
  return run === undefined ? null : run.evidence;
};

/** Only the fact identities needed to decide which claims need attention. */
export const readContestedFactIds = async (args: ReadVerificationRunArgs) => {
  const evidence = await readRunEvidenceForGrading(args);
  return evidence === null ? null : contestedFactIds(evidence);
};

type ReadFactStandingsArgs = {
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
  evidence: VerificationEvidence;
};

/**
 * How each fact a run pinned stands on its list now, for the qualifiers
 * computed at read time. A fact taken off the list since keeps the standing
 * the run pinned: included, with the sources the run read.
 */
const readFactStandings = async ({
  tx,
  workspaceId,
  evidence,
}: ReadFactStandingsArgs): Promise<
  ReadonlyMap<SafeId<"entity">, FactStanding>
> => {
  const standings = new Map<SafeId<"entity">, FactStanding>(
    evidence.facts.map((fact) => [
      fact.factEntityId,
      {
        scoring: "included",
        sourcing: fact.sources.length > 0 ? "sourced" : "unsourced",
      },
    ]),
  );
  const factIds = [...standings.keys()];
  if (factIds.length === 0) {
    return standings;
  }
  const onList = await tx
    .select({
      factEntityId: legalListItems.entityId,
      scoring: legalListFactDetails.scoring,
    })
    .from(legalListItems)
    .leftJoin(
      legalListFactDetails,
      eq(legalListFactDetails.itemEntityId, legalListItems.entityId),
    )
    .where(
      and(
        eq(legalListItems.workspaceId, workspaceId),
        eq(legalListItems.listId, evidence.listId),
        inArray(legalListItems.entityId, factIds),
      ),
    )
    .limit(factIds.length);
  if (onList.length === 0) {
    return standings;
  }
  // A rejected source no longer says where a fact comes from, as when the
  // run pinned its evidence.
  const sourced = await tx
    .select({ factEntityId: legalListItemSources.itemEntityId })
    .from(legalListItemSources)
    .where(
      and(
        eq(legalListItemSources.workspaceId, workspaceId),
        inArray(
          legalListItemSources.itemEntityId,
          onList.map((fact) => fact.factEntityId),
        ),
        ne(legalListItemSources.verificationStatus, "rejected"),
      ),
    )
    .groupBy(legalListItemSources.itemEntityId)
    .limit(onList.length);
  const sourcedIds = new Set(sourced.map((fact) => fact.factEntityId));
  for (const { factEntityId, scoring } of onList) {
    standings.set(factEntityId, {
      // A fact nobody has described yet scores, as when a run pins it.
      scoring: scoring ?? "included",
      sourcing: sourcedIds.has(factEntityId) ? "sourced" : "unsourced",
    });
  }
  return standings;
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
  const standings = await readFactStandings({
    tx,
    workspaceId,
    evidence: run.evidence,
  });
  const standingOf = (factEntityId: SafeId<"entity">) =>
    standings.get(factEntityId) ??
    panic("A claim rests on a fact its run did not pin");

  return {
    id: run.id,
    entityId: run.entityId,
    fileFieldId: run.fileFieldId,
    entityVersionId: run.entityVersionId,
    evidence: run.evidence,
    // How each pinned fact stands on the list now: what the computed
    // qualifiers read, so a reader shows the same footing they state.
    factStandings: [...standings].map(([factEntityId, standing]) => ({
      factEntityId,
      scoring: standing.scoring,
      sourcing: standing.sourcing,
    })),
    status: run.status,
    errorCode: run.errorCode,
    pipelineVersion: run.pipelineVersion,
    modelRef: run.modelRef,
    requestedBy: run.requestedBy,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    blocks,
    claims: claims.map((claim) => {
      const verdict = toClaimVerdict(claim);
      const review = reviews.get(claim.id)?.review ?? null;
      return {
        id: claim.id,
        position: claim.position,
        type: claim.type,
        framing: claim.framing,
        verdict,
        qualifiers: claimQualifiers({
          graded: claim.qualifiers,
          resting: restingFactIds({ verdict, refs: claim.refs }, review).map(
            standingOf,
          ),
        }),
        text: claim.text,
        anchor: claim.anchor,
        refs: claim.refs,
        review: review === null ? null : serializeClaimReview(review),
      };
    }),
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
