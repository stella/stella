/**
 * One verification run, its claims, and each claim's current review. Shared by the
 * point read and the review-event handlers so both answer with one shape.
 *
 * Bounded by construction: the engine caps claims per run, and events are
 * folded per claim in one ordered read rather than one query per claim.
 */

import { panic } from "better-result";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import type { Transaction } from "@/api/db/root";
import {
  entities,
  legalListClaimCarryOutcomes,
  legalListClaimReviewEvents,
  legalListClaims,
  legalListFactDetails,
  legalListItems,
  legalListVerificationBlocks,
  legalListVerificationRuns,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readBounded } from "@/api/lib/db/read-bounded";
import { readFactTiers, readSourceKinds } from "@/api/lib/lists/fact-tiers";
import { factTier } from "@/api/lib/lists/source-kind";
import { claimAssertedDate } from "@/api/lib/lists/verification/claim-date";
import type {
  ClaimAssertedDate,
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
import { verificationBlockId } from "@/api/lib/lists/verification/document-text";
import {
  readHeldFactIds,
  readVerificationEvidence,
} from "@/api/lib/lists/verification/evidence";
import { suggestedGoverningFactId } from "@/api/lib/lists/verification/governing-suggestion";
import { scopedBlockContext } from "@/api/lib/lists/verification/paragraph-scope";
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
  EMPTY_CLAIM_REVIEW,
  foldClaimReview,
  gradeOf,
  linksChangedSinceGrade,
  needsAttention,
  rejectRecheck,
  reviewedView,
} from "@/api/lib/lists/verification/review-fold";
import {
  citedFactIds,
  claimStaleness,
  gradePins,
  listFactsNow,
} from "@/api/lib/lists/verification/staleness";
import type {
  GradePins,
  ListFactsNow,
} from "@/api/lib/lists/verification/staleness";

/** A claim's review on the wire, with how many actions its history holds and
 *  whether its links changed since its grade. Its latest re-check is part of
 *  the claim's grade, so the claim states it (`presentRecheck`). */
export const serializeClaimReview = ({
  review,
  eventCount,
}: ClaimReviewRecord) => {
  // The shared decision is the status read in the shared vocabulary; the
  // wire states the status itself.
  const { recheck: _onTheClaim, decision: _sharedReading, ...wire } = review;
  return {
    ...wire,
    linksChanged: linksChangedSinceGrade(review),
    noteSavedAt: wire.noteSavedAt?.toISOString() ?? null,
    decidedAt: wire.decidedAt?.toISOString() ?? null,
    eventCount,
  };
};

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
> =>
  await readClaimReviewsOfRuns({
    tx,
    workspaceId,
    runIds: [runId],
    ...(claimIds === undefined ? {} : { claimIds }),
  });

type ReadClaimReviewsOfRunsArgs = {
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
  runIds: readonly SafeId<"legalListVerificationRun">[];
  /** Narrow to these claims; omitted reads every claim of the runs. */
  claimIds?: readonly SafeId<"legalListClaim">[];
};

/** Current review per claim id across several runs, in one ordered read.
 *  A claim with no events has no entry. */
export const readClaimReviewsOfRuns = async ({
  tx,
  workspaceId,
  runIds,
  claimIds,
}: ReadClaimReviewsOfRunsArgs): Promise<
  Map<SafeId<"legalListClaim">, ClaimReviewRecord>
> => {
  if (runIds.length === 0 || claimIds?.length === 0) {
    return new Map();
  }
  // Bounded by the caps the writers enforce: claims per run and actions per
  // claim.
  const claimCount =
    claimIds?.length ?? runIds.length * VERIFICATION_LIMITS.CLAIMS_PER_RUN_MAX;
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
        runIds.length === 1
          ? eq(
              legalListClaimReviewEvents.runId,
              runIds[0] ?? panic("A review read names no run"),
            )
          : inArray(legalListClaimReviewEvents.runId, [...runIds]),
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
export const factsWithRechecks = (
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

/** What deciding which claims need attention reads of a run: the facts it
 *  pinned (and which of them are contested), and how every fact its claims
 *  can rest on stands now. `null` when the workspace holds no such run. */
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
    pinned,
    contested: contestedFactIds(pinned),
    standings: await readFactStandings({
      tx: args.tx,
      workspaceId: args.workspaceId,
      evidence,
    }),
  };
};

type AttentionInputs = NonNullable<
  Awaited<ReturnType<typeof readRunAttentionInputs>>
>;

/**
 * The contested facts as a claim's own grade read them: a re-checked
 * claim by the facts its latest re-check read, every other one by the
 * run's pinned facts.
 */
export const contestedFactIdsOfClaim = (
  inputs: Pick<AttentionInputs, "pinned" | "contested">,
  review: ClaimReview,
): ReadonlySet<SafeId<"entity">> =>
  review.recheck === null
    ? inputs.contested
    : contestedFactIds({
        listId: inputs.pinned.listId,
        facts: applyFactChanges(inputs.pinned.facts, review.recheck.facts),
      });

/**
 * Whether a claim needs a person (`needsAttention`), read as its reviewers
 * see it: its current grade, a reopening or a governed record conflict, and
 * the qualifiers the facts it rests on give it now. The one reading of the
 * rule: the run read serves it on every claim, and bulk acceptance refuses
 * by it, so the routine claims a reviewer is offered are the ones the
 * server accepts.
 */
export const claimNeedsAttention = (
  claim: QualifiedClaimRow,
  review: ClaimReview | null,
  inputs: AttentionInputs,
): boolean => {
  const current = review ?? EMPTY_CLAIM_REVIEW;
  return needsAttention(
    {
      ...reviewedView(claim, current),
      qualifiers: qualifiersOfClaim(claim, current, inputs.standings),
    },
    contestedFactIdsOfClaim(inputs, current),
  );
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
  const cited = new Set(citedFactIds(recheck.grade));
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
export const readFactStandings = async ({
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

type ReadRunsWithEvidenceArgs = {
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
  runIds: readonly SafeId<"legalListVerificationRun">[];
};

/** Several runs with the evidence each pinned and its document's name, in
 *  one read, for a reader that draws many runs at once (a list's
 *  verification graph). A run the workspace does not hold is absent. */
export const readRunsWithEvidence = async ({
  tx,
  workspaceId,
  runIds,
}: ReadRunsWithEvidenceArgs) =>
  runIds.length === 0
    ? []
    : await tx
        .select({
          id: legalListVerificationRuns.id,
          entityVersionId: legalListVerificationRuns.entityVersionId,
          evidence: legalListVerificationRuns.evidence,
          finishedAt: legalListVerificationRuns.finishedAt,
          documentName: entities.name,
        })
        .from(legalListVerificationRuns)
        .innerJoin(
          entities,
          and(
            eq(entities.id, legalListVerificationRuns.entityId),
            eq(entities.workspaceId, legalListVerificationRuns.workspaceId),
          ),
        )
        .where(
          and(
            eq(legalListVerificationRuns.workspaceId, workspaceId),
            inArray(legalListVerificationRuns.id, [...runIds]),
          ),
        )
        .limit(runIds.length);

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

type ReadListNowArgs = {
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
  /** Every fact a run's claims can rest on (`factsWithRechecks`). */
  evidence: VerificationEvidence;
};

/**
 * The run's list as it stands now, which each claim's staleness is read
 * against: the facts checked against now, and which facts the run's grades
 * read are held out of scoring since. `null` when the list holds more facts
 * than one check reads, so no claim of it can be checked again either.
 */
const readListNow = async ({
  tx,
  workspaceId,
  evidence,
}: ReadListNowArgs): Promise<ListFactsNow | null> => {
  const read = await readVerificationEvidence({
    tx,
    workspaceId,
    listId: evidence.listId,
  });
  if (read.type === "too-many-facts") {
    return null;
  }
  const scored = new Set(read.evidence.facts.map((fact) => fact.factEntityId));
  return listFactsNow({
    scored: read.evidence.facts,
    held: await readHeldFactIds({
      tx,
      workspaceId,
      listId: evidence.listId,
      factIds: evidence.facts
        .map((fact) => fact.factEntityId)
        .filter((factEntityId) => !scored.has(factEntityId)),
    }),
  });
};

type ClaimStalenessArgs = {
  claim: QualifiedClaimRow & { text: string };
  review: ClaimReview | null;
  /** The facts the run pinned, keyed once for every claim. */
  runPins: GradePins;
  pinned: readonly VerificationEvidenceFact[];
  now: ListFactsNow | null;
};

/** Why the claim's current grade may no longer stand on the list as it is
 *  now (`claimStaleness`); null when the list cannot be read whole. */
const stalenessOfClaim = ({
  claim,
  review,
  runPins,
  pinned,
  now,
}: ClaimStalenessArgs) => {
  if (now === null) {
    return null;
  }
  const recheck = review?.recheck ?? null;
  return claimStaleness(
    {
      text: claim.text,
      grade: gradeOf(claim, review),
      pins:
        recheck === null
          ? runPins
          : gradePins(applyFactChanges(pinned, recheck.facts)),
      linkedFactIds: (review ?? EMPTY_CLAIM_REVIEW).linkedFactIds,
      recheckable: rejectRecheck(claim, review ?? EMPTY_CLAIM_REVIEW) === null,
    },
    now,
  );
};

type AssertedDateColumns = Pick<
  typeof legalListClaims.$inferSelect,
  "text" | "assertedOn" | "assertedOnPrecision" | "assertedOnSource"
>;

/**
 * The date a claim asserts, as its reviewers read it: its latest
 * re-check's reading, else its run's. A claim written before claims carried
 * dates is read from its words now, exactly as the backfill stores it.
 */
const assertedDateOfClaim = (
  claim: AssertedDateColumns,
  review: ClaimReview | null,
): ClaimAssertedDate => {
  const rechecked = review?.recheck?.assertedOn ?? null;
  if (rechecked !== null) {
    return rechecked;
  }
  const source = claim.assertedOnSource;
  switch (source) {
    case "pending": {
      return claimAssertedDate(claim.text, null);
    }
    case "none": {
      return { type: "none" };
    }
    case "text":
    case "grader": {
      return {
        type: "dated",
        source,
        date: claim.assertedOn ?? panic("A dated claim has no date"),
        precision:
          claim.assertedOnPrecision ?? panic("A dated claim has no precision"),
      };
    }
    default: {
      source satisfies never;
      return panic(`Unhandled asserted date source: ${String(source)}`);
    }
  }
};

type PresentClaimArgs = {
  claim: typeof legalListClaims.$inferSelect;
  record: ClaimReviewRecord | null;
  inputs: AttentionInputs;
  runPins: GradePins;
  now: ListFactsNow | null;
};

/** One claim on the wire, read with its current grade; a re-check names the
 *  run's grade it replaced. */
const presentClaim = ({
  claim,
  record,
  inputs,
  runPins,
  now,
}: PresentClaimArgs) => {
  const { standings } = inputs;
  const pinned = inputs.pinned.facts;
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
    needsAttention: claimNeedsAttention(claim, review, inputs),
    // Only a suggestion: the conflict stays open until a person names the
    // governing record.
    suggestedGoverningFactId: governingSuggestionOfClaim(
      claim,
      review,
      standings,
    ),
    text: claim.text,
    assertedOn: assertedDateOfClaim(claim, review),
    anchor: claim.anchor,
    // The printed number of the paragraph the claim sits in, as the run
    // stored it; null when it sits outside any numbered paragraph.
    paragraph: claim.paragraphNumber,
    refs: graded.refs,
    review: record === null ? null : serializeClaimReview(record),
    recheck:
      recheck === null ? null : presentRecheck({ claim, recheck, pinned }),
    // Why the grade may no longer stand on the list as it is now: empty
    // when no reason was found, null when the list holds more facts than a
    // check reads.
    staleness: stalenessOfClaim({ claim, review, runPins, pinned, now }),
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
  const evidence = factsWithRechecks(row.evidence, reviews);
  return presentClaim({
    claim: row.claim,
    record: reviews.get(claimId) ?? null,
    inputs: {
      pinned: row.evidence,
      contested: contestedFactIds(row.evidence),
      standings: await readFactStandings({ tx, workspaceId, evidence }),
    },
    runPins: gradePins(row.evidence.facts),
    now: await readListNow({ tx, workspaceId, evidence }),
  });
};

type ReadRunClaimsForCarryArgs = {
  tx: Pick<PgAsyncDatabase<PgQueryResultHKT>, "select">;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"legalListVerificationRun">;
};

/**
 * A run's claims as carrying review decisions forward matches them: words,
 * place, and the grade the run wrote. The caller resolves a reviewed
 * claim's grade through its fold (`gradeOf`); claims per run are capped by
 * their position check.
 */
export const readRunClaimsForCarry = async ({
  tx,
  workspaceId,
  runId,
}: ReadRunClaimsForCarryArgs) =>
  await readBounded(
    tx
      .select({
        id: legalListClaims.id,
        text: legalListClaims.text,
        anchor: legalListClaims.anchor,
        state: legalListClaims.state,
        recordConflict: legalListClaims.recordConflict,
      })
      .from(legalListClaims)
      .where(
        and(
          eq(legalListClaims.workspaceId, workspaceId),
          eq(legalListClaims.runId, runId),
        ),
      )
      .orderBy(asc(legalListClaims.position)),
    VERIFICATION_LIMITS.CLAIMS_PER_RUN_MAX,
  );

/**
 * What the run carried from the previous run of its document: the run it
 * read, how many reviewed claims came across whole, and the ones that did
 * not (their words as that run has them, why, and the claim they matched
 * when one did). `null` when nothing was there to carry.
 */
const readCarryOver = async ({
  tx,
  workspaceId,
  runId,
}: ReadVerificationRunArgs) => {
  const outcomes = legalListClaimCarryOutcomes;
  // One outcome per claim of the previous run, whose claims are capped.
  const read = await readBounded(
    tx
      .select({
        sourceRunId: outcomes.sourceRunId,
        sourceRunCreatedAt: legalListVerificationRuns.createdAt,
        sourceClaimId: outcomes.sourceClaimId,
        outcome: outcomes.outcome,
        targetClaimId: outcomes.targetClaimId,
        text: legalListClaims.text,
      })
      .from(outcomes)
      .innerJoin(
        legalListClaims,
        and(
          eq(legalListClaims.id, outcomes.sourceClaimId),
          eq(legalListClaims.runId, outcomes.sourceRunId),
          eq(legalListClaims.workspaceId, workspaceId),
        ),
      )
      .innerJoin(
        legalListVerificationRuns,
        and(
          eq(legalListVerificationRuns.id, outcomes.sourceRunId),
          eq(legalListVerificationRuns.workspaceId, workspaceId),
        ),
      )
      .where(
        and(eq(outcomes.workspaceId, workspaceId), eq(outcomes.runId, runId)),
      )
      .orderBy(asc(legalListClaims.position)),
    VERIFICATION_LIMITS.CLAIMS_PER_RUN_MAX,
  );
  const rows =
    read.type === "complete"
      ? read.rows
      : panic("A run carried more outcomes than its source run has claims");
  const [first] = rows;
  if (first === undefined) {
    return null;
  }
  return {
    sourceRunId: first.sourceRunId,
    sourceRunCreatedAt: first.sourceRunCreatedAt.toISOString(),
    carriedCount: rows.filter((row) => row.outcome === "carried").length,
    notCarried: rows.flatMap((row) =>
      row.outcome === "carried"
        ? []
        : [
            {
              sourceClaimId: row.sourceClaimId,
              text: row.text,
              outcome: row.outcome,
              targetClaimId: row.targetClaimId,
            },
          ],
    ),
  };
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
  const evidence = factsWithRechecks(run.evidence, reviews);
  const standings = await readFactStandings({ tx, workspaceId, evidence });
  const now = await readListNow({ tx, workspaceId, evidence });
  const runPins = gradePins(run.evidence.facts);
  const attention: AttentionInputs = {
    pinned: run.evidence,
    contested: contestedFactIds(run.evidence),
    standings,
  };

  return {
    id: run.id,
    entityId: run.entityId,
    fileFieldId: run.fileFieldId,
    entityVersionId: run.entityVersionId,
    evidence: run.evidence,
    scope: run.scope,
    // How each pinned fact stands on the list now: what the computed
    // qualifiers read, so a reader shows the same footing they state.
    factStandings: [...standings].map(([factEntityId, standing]) => ({
      factEntityId,
      scoring: standing.scoring,
      tier: standing.tier,
    })),
    status: run.status,
    errorCode: run.errorCode,
    // Text a completed run could not read; empty when it read everything.
    unreadParts: run.unreadParts,
    pipelineVersion: run.pipelineVersion,
    modelRef: run.modelRef,
    requestedBy: run.requestedBy,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    blocks,
    carryOver: await readCarryOver({ tx, workspaceId, runId }),
    claims: claims.map((claim) =>
      presentClaim({
        claim,
        record: reviews.get(claim.id) ?? null,
        inputs: attention,
        runPins,
        now,
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

type ReadRecheckTargetsArgs = ReadVerificationRunArgs & {
  claimIds: readonly SafeId<"legalListClaim">[];
};

/** The block a claim sits in, as both the claim's anchor and a stored block
 *  name it. */
const blockKeyOf = (
  block:
    | { type: "docx-block"; blockId: string }
    | { type: "pdf-page"; pageNumber: number },
): string =>
  block.type === "docx-block"
    ? `docx:${block.blockId}`
    : `pdf:${String(block.pageNumber)}`;

/**
 * What re-checking claims of one run reads: the facts the run pinned, the
 * run's document version, and per claim the claim as written with the text
 * of the block it sits in, cut to the run's paragraph range as the run's
 * grading read it (the grader reads it for the claim's meaning). A claim the
 * workspace does not hold has no entry; `null` when it holds no such run.
 */
export const readRecheckTargets = async ({
  tx,
  workspaceId,
  runId,
  claimIds,
}: ReadRecheckTargetsArgs) => {
  const run = (
    await tx
      .select({
        evidence: legalListVerificationRuns.evidence,
        entityVersionId: legalListVerificationRuns.entityVersionId,
        scope: legalListVerificationRuns.scope,
      })
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
  const claims =
    claimIds.length === 0
      ? []
      : await tx
          .select({
            id: legalListClaims.id,
            state: legalListClaims.state,
            recordConflict: legalListClaims.recordConflict,
            text: legalListClaims.text,
            anchor: legalListClaims.anchor,
          })
          .from(legalListClaims)
          .where(
            and(
              eq(legalListClaims.workspaceId, workspaceId),
              eq(legalListClaims.runId, runId),
              inArray(legalListClaims.id, [...claimIds]),
            ),
          )
          .limit(claimIds.length);
  const blockIds = [
    ...new Set(
      claims.flatMap(({ anchor }) =>
        anchor.type === "docx-block" ? [anchor.blockId] : [],
      ),
    ),
  ];
  const pageNumbers = [
    ...new Set(
      claims.flatMap(({ anchor }) =>
        anchor.type === "pdf-page" ? [anchor.pageNumber] : [],
      ),
    ),
  ];
  const blocks =
    claims.length === 0
      ? []
      : await tx
          .select({
            kind: legalListVerificationBlocks.kind,
            blockId: legalListVerificationBlocks.blockId,
            pageNumber: legalListVerificationBlocks.pageNumber,
            text: legalListVerificationBlocks.text,
          })
          .from(legalListVerificationBlocks)
          .where(
            and(
              eq(legalListVerificationBlocks.workspaceId, workspaceId),
              eq(legalListVerificationBlocks.runId, runId),
              or(
                blockIds.length === 0
                  ? undefined
                  : and(
                      eq(legalListVerificationBlocks.kind, "docx-block"),
                      inArray(legalListVerificationBlocks.blockId, blockIds),
                    ),
                pageNumbers.length === 0
                  ? undefined
                  : and(
                      eq(legalListVerificationBlocks.kind, "pdf-page"),
                      inArray(
                        legalListVerificationBlocks.pageNumber,
                        pageNumbers,
                      ),
                    ),
              ),
            ),
          )
          .limit(blockIds.length + pageNumbers.length);
  const blockText = new Map(
    blocks.flatMap((block) => {
      if (block.kind === "docx-block") {
        return [
          [
            blockKeyOf({ type: "docx-block", blockId: block.blockId }),
            block.text,
          ] as const,
        ];
      }
      // A page block always carries its number (the table's checks).
      if (block.pageNumber !== null) {
        return [
          [
            blockKeyOf({ type: "pdf-page", pageNumber: block.pageNumber }),
            block.text,
          ] as const,
        ];
      }
      return [];
    }),
  );
  const { scope, ...target } = run;
  return {
    ...target,
    claims: new Map(
      claims.map(({ id, ...claim }) => [
        id,
        {
          ...claim,
          context: scopedBlockContext(
            {
              id: verificationBlockId(claim.anchor),
              text:
                blockText.get(blockKeyOf(claim.anchor)) ??
                panic("A claim's block is missing from its run"),
            },
            scope,
            claim.anchor,
          ),
        },
      ]),
    ),
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
