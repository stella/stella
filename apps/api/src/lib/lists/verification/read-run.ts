/**
 * One verification run, its claims, and each claim's current review. Shared by the
 * point read and the review-event handlers so both answer with one shape.
 *
 * Bounded by construction: the engine caps claims per run, and events are
 * folded per claim in one ordered read rather than one query per claim.
 */

import { panic } from "better-result";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import type { Transaction } from "@/api/db/root";
import {
  entities,
  legalListClaimReviewEvents,
  legalListClaims,
  legalListFactDetails,
  legalListItems,
  legalListVerificationBlocks,
  legalListVerificationRuns,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readFactTiers, readSourceKinds } from "@/api/lib/lists/fact-tiers";
import { factTier } from "@/api/lib/lists/source-kind";
import type {
  ClaimRef,
  ClaimState,
  ClaimVerdict,
  RecordConflict,
  VerificationEvidence,
  VerificationEvidenceFact,
} from "@/api/lib/lists/verification/contract";
import {
  gradedClaimType,
  VERIFICATION_LIMITS,
} from "@/api/lib/lists/verification/contract";
import { suggestedGoverningFactId } from "@/api/lib/lists/verification/governing-suggestion";
import {
  claimQualifiers,
  restingFactIds,
} from "@/api/lib/lists/verification/qualifiers";
import type {
  FactStanding,
  GraderClaimQualifier,
} from "@/api/lib/lists/verification/qualifiers";
import { applyFactChanges } from "@/api/lib/lists/verification/recheck-facts";
import type {
  ClaimRecheck,
  ClaimReview,
} from "@/api/lib/lists/verification/review-fold";
import {
  contestedFactIds,
  foldClaimReview,
  gradeOf,
} from "@/api/lib/lists/verification/review-fold";

/** A claim's review on the wire, with how many actions its history holds.
 *  Its latest re-check is part of the claim's grade, so the claim states it
 *  (`presentRecheck`). */
export const serializeClaimReview = ({
  review: { recheck: _recheck, ...review },
  eventCount,
}: ClaimReviewRecord) => ({
  ...review,
  noteSavedAt: review.noteSavedAt?.toISOString() ?? null,
  decidedAt: review.decidedAt?.toISOString() ?? null,
  eventCount,
});

type ReadClaimReviewsArgs = {
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"legalListVerificationRun">;
  /** Narrow to these claims; omitted reads every claim of the run. */
  claimIds?: readonly SafeId<"legalListClaim">[];
};

export type ClaimReviewRecord = {
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

type FactStandings = ReadonlyMap<SafeId<"entity">, FactStanding>;

type QualifiedClaimRow = ClaimVerdictColumns & {
  refs: readonly ClaimRef[];
  qualifiers: readonly GraderClaimQualifier[];
};

/** Every qualifier of a stored claim, read with its current grade
 *  (`gradeOf`): the grader's, and the ones the facts its verdict rests on
 *  give it as they stand now. */
export const qualifiersOfClaim = (
  claim: QualifiedClaimRow,
  review: ClaimReview | null,
  standings: FactStandings,
) => {
  const graded = gradeOf(claim, review);
  return claimQualifiers({
    graded: graded.qualifiers,
    resting: restingFactIds(
      { verdict: toClaimVerdict(graded), refs: graded.refs },
      review,
    ).map(
      (factEntityId) =>
        standings.get(factEntityId) ??
        panic("A claim rests on a fact neither its run nor a re-check pinned"),
    ),
  });
};

/**
 * Every fact a run's claims can rest on: the facts the run pinned, and the
 * facts its claims' latest re-checks read that the run did not (or read
 * differently, the later reading kept).
 */
const factsWithRechecks = (
  evidence: VerificationEvidence,
  reviews: ReadonlyMap<SafeId<"legalListClaim">, ClaimReviewRecord>,
): VerificationEvidence => {
  const facts = new Map(
    evidence.facts.map((fact) => [fact.factEntityId, fact]),
  );
  const rechecks = [...reviews.values()]
    .flatMap(({ review }) => (review.recheck === null ? [] : [review.recheck]))
    .toSorted((a, b) => a.checkedAt.getTime() - b.checkedAt.getTime());
  for (const recheck of rechecks) {
    for (const fact of recheck.facts.changed) {
      facts.set(fact.factEntityId, fact);
    }
  }
  return { listId: evidence.listId, facts: [...facts.values()] };
};

/** What deciding which claims need attention reads of a run: the facts whose
 *  meaning is contested, and how every fact its claims can rest on stands
 *  now. `null` when the workspace holds no such run. */
export const readRunAttentionInputs = async (args: ReadVerificationRunArgs) => {
  const pinned = await readRunEvidenceForGrading(args);
  if (pinned === null) {
    return null;
  }
  const evidence = factsWithRechecks(
    pinned,
    await readClaimReviews({
      tx: args.tx,
      workspaceId: args.workspaceId,
      runId: args.runId,
    }),
  );
  return {
    contested: contestedFactIds(evidence),
    standings: await readFactStandings({
      tx: args.tx,
      workspaceId: args.workspaceId,
      evidence,
    }),
  };
};

type PresentRecheckArgs = {
  claim: QualifiedClaimRow;
  recheck: ClaimRecheck;
  pinned: readonly VerificationEvidenceFact[];
};

/**
 * A claim's latest re-check on the wire: who asked and when, how many facts
 * it read, the facts its grade cites as it read them (so a fact added since
 * the run still shows), and the grade the run gave, which it replaced.
 */
const presentRecheck = ({ claim, recheck, pinned }: PresentRecheckArgs) => {
  const read = applyFactChanges(pinned, recheck.facts);
  const cited = new Set<SafeId<"entity">>([
    ...recheck.grade.refs.map((ref) => ref.factEntityId),
    ...(recheck.grade.recordConflict?.factEntityIds ?? []),
  ]);
  return {
    checkedAt: recheck.checkedAt.toISOString(),
    checkedBy: recheck.checkedBy,
    modelRef: recheck.modelRef,
    factCount: read.length,
    facts: read.filter((fact) => cited.has(fact.factEntityId)),
    original: {
      verdict: toClaimVerdict(claim),
      refs: claim.refs,
      qualifiers: claim.qualifiers,
    },
  };
};

type ReadFactStandingsArgs = {
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
  evidence: VerificationEvidence;
};

/**
 * How each fact a run pinned stands on its list now, for the qualifiers
 * computed at read time. A fact taken off the list since keeps the standing
 * the run pinned: included, with the sources the run read, each of the kind
 * its document has on the list now.
 */
const readFactStandings = async ({
  tx,
  workspaceId,
  evidence,
}: ReadFactStandingsArgs): Promise<FactStandings> => {
  const scope = { tx, workspaceId, listId: evidence.listId };
  const factIds = evidence.facts.map((fact) => fact.factEntityId);
  if (factIds.length === 0) {
    return new Map();
  }
  const pinnedKinds = await readSourceKinds({
    ...scope,
    documentIds: evidence.facts.flatMap((fact) =>
      fact.sources.map((source) => source.sourceEntityId),
    ),
  });
  const standings = new Map<SafeId<"entity">, FactStanding>(
    evidence.facts.map((fact) => [
      fact.factEntityId,
      {
        scoring: "included",
        tier: factTier(
          fact.sources.map(
            (source) =>
              pinnedKinds.get(source.sourceEntityId) ??
              panic("A pinned source has no kind"),
          ),
        ),
      },
    ]),
  );
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
  const tiers = await readFactTiers({
    ...scope,
    factIds: onList.map((fact) => fact.factEntityId),
  });
  for (const { factEntityId, scoring } of onList) {
    standings.set(factEntityId, {
      // A fact nobody has described yet scores, as when a run pins it.
      scoring: scoring ?? "included",
      tier: tiers.get(factEntityId) ?? panic("A listed fact has no tier"),
    });
  }
  return standings;
};

/** How every fact a run's claims can rest on stands now (the run's pinned
 *  facts and its re-checks' facts), keyed by fact. `null` when the
 *  workspace holds no such run. */
export const readRunFactStandings = async (args: ReadVerificationRunArgs) => {
  const evidence = await readRunEvidenceForGrading(args);
  return evidence === null
    ? null
    : readFactStandings({
        tx: args.tx,
        workspaceId: args.workspaceId,
        evidence: factsWithRechecks(
          evidence,
          await readClaimReviews({
            tx: args.tx,
            workspaceId: args.workspaceId,
            runId: args.runId,
          }),
        ),
      });
};

/** The record suggested to govern a claim withheld between two facts, as
 *  they stand now and read with its current grade; null for any other
 *  claim. */
export const governingSuggestionOfClaim = (
  claim: Pick<QualifiedClaimRow, "state" | "recordConflict">,
  review: ClaimReview | null,
  standings: FactStandings,
) => {
  const { recordConflict } = gradeOf(claim, review);
  return recordConflict === null
    ? null
    : suggestedGoverningFactId({
        conflict: recordConflict,
        tierOf: (factEntityId) =>
          standings.get(factEntityId)?.tier ??
          panic(
            "A record conflict names a fact neither its run nor a re-check pinned",
          ),
      });
};

type PresentClaimArgs = {
  claim: typeof legalListClaims.$inferSelect;
  record: ClaimReviewRecord | null;
  standings: FactStandings;
  pinned: readonly VerificationEvidenceFact[];
};

/** One claim on the wire, read with its current grade; a re-check names the
 *  run's grade it replaced. */
const presentClaim = ({
  claim,
  record,
  standings,
  pinned,
}: PresentClaimArgs) => {
  const review = record?.review ?? null;
  const recheck = review?.recheck ?? null;
  const graded = gradeOf(claim, review);
  return {
    id: claim.id,
    position: claim.position,
    type: recheck === null ? claim.type : gradedClaimType(recheck.grade),
    framing: claim.framing,
    verdict: toClaimVerdict(graded),
    qualifiers: qualifiersOfClaim(claim, review, standings),
    // Only a suggestion: the conflict stays open until a person names the
    // governing record.
    suggestedGoverningFactId: governingSuggestionOfClaim(
      claim,
      review,
      standings,
    ),
    text: claim.text,
    anchor: claim.anchor,
    refs: graded.refs,
    review: record === null ? null : serializeClaimReview(record),
    recheck:
      recheck === null ? null : presentRecheck({ claim, recheck, pinned }),
  };
};

type ReadVerifiedClaimArgs = ReadVerificationRunArgs & {
  claimId: SafeId<"legalListClaim">;
};

/** One claim as the run read presents it. `null` when the workspace holds
 *  no such claim. */
export const readVerifiedClaim = async ({
  tx,
  workspaceId,
  runId,
  claimId,
}: ReadVerifiedClaimArgs) => {
  const row = (
    await tx
      .select({
        claim: legalListClaims,
        evidence: legalListVerificationRuns.evidence,
      })
      .from(legalListClaims)
      .innerJoin(
        legalListVerificationRuns,
        and(
          eq(legalListVerificationRuns.id, legalListClaims.runId),
          eq(legalListVerificationRuns.workspaceId, workspaceId),
        ),
      )
      .where(
        and(
          eq(legalListClaims.id, claimId),
          eq(legalListClaims.runId, runId),
          eq(legalListClaims.workspaceId, workspaceId),
        ),
      )
      .limit(1)
  ).at(0);
  if (row === undefined) {
    return null;
  }
  const reviews = await readClaimReviews({
    tx,
    workspaceId,
    runId,
    claimIds: [claimId],
  });
  return presentClaim({
    claim: row.claim,
    record: reviews.get(claimId) ?? null,
    standings: await readFactStandings({
      tx,
      workspaceId,
      evidence: factsWithRechecks(row.evidence, reviews),
    }),
    pinned: row.evidence.facts,
  });
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
    evidence: factsWithRechecks(run.evidence, reviews),
  });

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
      tier: standing.tier,
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
    claims: claims.map((claim) =>
      presentClaim({
        claim,
        record: reviews.get(claim.id) ?? null,
        standings,
        pinned: run.evidence.facts,
      }),
    ),
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
      score: legalListClaims.score,
      refs: legalListClaims.refs,
      recordConflict: legalListClaims.recordConflict,
      qualifiers: legalListClaims.qualifiers,
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

type ReadRecheckTargetArgs = ReadVerificationRunArgs & {
  claimId: SafeId<"legalListClaim">;
};

/**
 * What re-checking one claim reads: the claim as written, the facts its run
 * pinned, the run's document version, and the text of the block the claim
 * sits in (the grader reads it for the claim's meaning). `null` when the
 * workspace holds no such claim.
 */
export const readRecheckTarget = async ({
  tx,
  workspaceId,
  runId,
  claimId,
}: ReadRecheckTargetArgs) => {
  const row = (
    await tx
      .select({
        claim: {
          state: legalListClaims.state,
          recordConflict: legalListClaims.recordConflict,
          text: legalListClaims.text,
          anchor: legalListClaims.anchor,
        },
        evidence: legalListVerificationRuns.evidence,
        entityVersionId: legalListVerificationRuns.entityVersionId,
      })
      .from(legalListClaims)
      .innerJoin(
        legalListVerificationRuns,
        and(
          eq(legalListVerificationRuns.id, legalListClaims.runId),
          eq(legalListVerificationRuns.workspaceId, workspaceId),
        ),
      )
      .where(
        and(
          eq(legalListClaims.id, claimId),
          eq(legalListClaims.runId, runId),
          eq(legalListClaims.workspaceId, workspaceId),
        ),
      )
      .limit(1)
  ).at(0);
  if (row === undefined) {
    return null;
  }
  const { anchor } = row.claim;
  const block = (
    await tx
      .select({ text: legalListVerificationBlocks.text })
      .from(legalListVerificationBlocks)
      .where(
        and(
          eq(legalListVerificationBlocks.workspaceId, workspaceId),
          eq(legalListVerificationBlocks.runId, runId),
          anchor.type === "docx-block"
            ? and(
                eq(legalListVerificationBlocks.kind, "docx-block"),
                eq(legalListVerificationBlocks.blockId, anchor.blockId),
              )
            : and(
                eq(legalListVerificationBlocks.kind, "pdf-page"),
                eq(legalListVerificationBlocks.pageNumber, anchor.pageNumber),
              ),
        ),
      )
      .limit(1)
  ).at(0);
  return {
    ...row,
    blockText: block?.text ?? panic("A claim's block is missing from its run"),
  };
};

export type LinkableFactRejection = "fact-not-on-list" | "fact-held";

type RejectLinkedFactArgs = {
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"legalListVerificationRun">;
  factEntityId: SafeId<"entity">;
};

/**
 * Whether a reviewer can point a claim at this fact: it must be a fact on
 * the list the run verified, and one that is checked against (a held fact
 * never is, so a re-check would not read it). Null when it can.
 */
export const rejectLinkedFact = async ({
  tx,
  workspaceId,
  runId,
  factEntityId,
}: RejectLinkedFactArgs): Promise<LinkableFactRejection | null> => {
  const fact = (
    await tx
      .select({ scoring: legalListFactDetails.scoring })
      .from(legalListVerificationRuns)
      .innerJoin(
        legalListItems,
        and(
          eq(legalListItems.workspaceId, workspaceId),
          // The run pins its list id as text inside its evidence.
          sql`${legalListItems.listId} = (${legalListVerificationRuns.evidence} ->> 'listId')::uuid`,
          eq(legalListItems.entityId, factEntityId),
        ),
      )
      .innerJoin(
        entities,
        and(
          eq(entities.id, legalListItems.entityId),
          eq(entities.workspaceId, workspaceId),
          eq(entities.listItemType, LIST_ITEM_TYPE.FACT),
        ),
      )
      .leftJoin(
        legalListFactDetails,
        eq(legalListFactDetails.itemEntityId, legalListItems.entityId),
      )
      .where(
        and(
          eq(legalListVerificationRuns.id, runId),
          eq(legalListVerificationRuns.workspaceId, workspaceId),
        ),
      )
      .limit(1)
  ).at(0);
  if (fact === undefined) {
    return "fact-not-on-list";
  }
  return fact.scoring === "held" ? "fact-held" : null;
};
