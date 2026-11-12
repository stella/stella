/**
 * Review decisions survive a re-run: when a run of a document completes,
 * every reviewer action on the previous completed run of that document
 * (same file, same list) follows its claim to the matching claim of the new
 * run, as far as `CLAIM_REVIEW_CARRY_RULE` lets it.
 *
 * Carried actions are new append-only events on the new claim that name the
 * run and event they copy; the previous run is only read. What became of each
 * reviewed claim is recorded once (`legal_list_claim_carry_outcomes`), so the
 * run can say what came across and what did not.
 *
 * Replay safe: it runs in the transaction that completes the run, and the
 * outcome row of a source claim is written before its events, which are
 * written only when that row is new. A replayed completion carries nothing
 * twice.
 */

import { panic } from "better-result";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  legalListClaimCarryOutcomes,
  legalListClaimReviewEvents,
  legalListClaims,
  legalListVerificationRuns,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { insertInChunks } from "@/api/lib/db/bulk-write";
import { readBounded } from "@/api/lib/db/read-bounded";
import { matchClaims } from "@/api/lib/lists/verification/claim-match";
import type { MatchableClaim } from "@/api/lib/lists/verification/claim-match";
import type {
  ClaimCarryOutcome,
  ClaimReviewEventPayload,
  RecordConflict,
  StoredClaimReviewEventPayload,
} from "@/api/lib/lists/verification/contract";
import {
  CLAIM_REVIEW_CARRY_RULE,
  VERIFICATION_LIMITS,
} from "@/api/lib/lists/verification/contract";
import { verificationRunListIdColumn } from "@/api/lib/lists/verification/read-run";
import {
  claimReviewSteps,
  foldClaimReview,
  gradeOf,
  rejectReviewEvent,
} from "@/api/lib/lists/verification/review-fold";

/** The verdict a decision was taken on: what decides whether it follows. */
type VerdictTarget = {
  state: (typeof legalListClaims.$inferSelect)["state"];
  recordConflict: RecordConflict | null;
};

/**
 * Whether two grades put the same verdict before a reviewer: the same state,
 * and for a record conflict the same two records (a governing choice names
 * one of them). The score is not shown to reviewers, so it does not count.
 */
export const sameReviewedVerdict = (
  left: VerdictTarget,
  right: VerdictTarget,
): boolean => {
  if (left.state !== right.state) {
    return false;
  }
  if (left.recordConflict === null || right.recordConflict === null) {
    return left.recordConflict === right.recordConflict;
  }
  const records = new Set(left.recordConflict.factEntityIds);
  return right.recordConflict.factEntityIds.every((id) => records.has(id));
};

export type CarriedSourceEvent = {
  id: SafeId<"legalListClaimReviewEvent">;
  payload: StoredClaimReviewEventPayload;
  actorId: string | null;
  createdAt: Date;
};

/** Whether the matching claim of the new run has the same words. */
export type ClaimWording = "same" | "edited";

/** Why one action did or did not follow its claim. */
export type CarryDecision =
  | "carried"
  /** Decided on words the new run's claim no longer has. */
  | "words-changed"
  /** Decided on a verdict the new run does not give the claim. */
  | "verdict-changed"
  /** A re-check: the new run is itself a fresh grade. */
  | "fresh-grade"
  /** Already true of the new claim once the actions before it followed
   *  (a second reopening after one already carried). */
  | "redundant";

export type ClaimCarryPlan = {
  /** The source claim's actions that follow, in fold order. */
  events: CarriedSourceEvent[];
  decisions: {
    eventId: SafeId<"legalListClaimReviewEvent">;
    decision: CarryDecision;
  }[];
  outcome: Extract<
    ClaimCarryOutcome,
    "carried" | "text-changed" | "verdict-changed"
  >;
};

/**
 * Which of one claim's actions follow it to its match in the new run. A
 * decision follows only to the same words: edited words may say something
 * else (two parties swapped), so a decision on the old words is withdrawn.
 * Each one is also judged on the verdict it was taken on (the source claim's
 * grade just before it, re-checks included) against the new claim's
 * verdict, and replayed on the new claim's fold so nothing that no longer
 * applies is written. Null when the claim has no action that could follow.
 */
export const planClaimCarry = ({
  source,
  events,
  target,
  wording,
}: {
  source: VerdictTarget;
  events: readonly CarriedSourceEvent[];
  target: VerdictTarget;
  wording: ClaimWording;
}): ClaimCarryPlan | null => {
  if (
    !events.some(
      (event) => CLAIM_REVIEW_CARRY_RULE[event.payload.kind] !== "never",
    )
  ) {
    return null;
  }
  const carried: CarriedSourceEvent[] = [];
  const decisions: ClaimCarryPlan["decisions"] = [];
  for (const { event, before } of claimReviewSteps(events)) {
    const decision = carryDecision({
      event,
      decidedOn: gradeOf(source, before),
      target,
      wording,
      carried,
    });
    decisions.push({ eventId: event.id, decision });
    if (decision === "carried") {
      carried.push(event);
    }
  }
  return {
    events: carried,
    decisions,
    outcome: planOutcome(decisions.map(({ decision }) => decision)),
  };
};

/** What the claim's outcome says: edited words first, since they withdraw
 *  every decision whatever the verdict. */
const planOutcome = (
  decisions: readonly CarryDecision[],
): ClaimCarryPlan["outcome"] => {
  if (decisions.includes("words-changed")) {
    return "text-changed";
  }
  return decisions.includes("verdict-changed") ? "verdict-changed" : "carried";
};

const carryDecision = ({
  event,
  decidedOn,
  target,
  wording,
  carried,
}: {
  event: CarriedSourceEvent;
  decidedOn: VerdictTarget;
  target: VerdictTarget;
  wording: ClaimWording;
  carried: readonly CarriedSourceEvent[];
}): CarryDecision => {
  const rule = CLAIM_REVIEW_CARRY_RULE[event.payload.kind];
  switch (rule) {
    case "never": {
      return "fresh-grade";
    }
    case "unchanged-claim": {
      if (wording === "edited") {
        return "words-changed";
      }
      if (!sameReviewedVerdict(decidedOn, target)) {
        return "verdict-changed";
      }
      break;
    }
    case "always": {
      break;
    }
    default: {
      rule satisfies never;
      return panic(`Unhandled carry rule: ${String(rule)}`);
    }
  }
  // The new claim is read with its run's grade throughout: re-checks never
  // follow, so nothing carried can change it.
  return rejectReviewEvent(target, foldClaimReview(carried), event.payload) ===
    null
    ? "carried"
    : "redundant";
};

type SourceClaim = MatchableClaim<SafeId<"legalListClaim">> & VerdictTarget;

type CarryRow = {
  outcome: typeof legalListClaimCarryOutcomes.$inferInsert;
  events: CarriedSourceEvent[];
};

/**
 * Every reviewed source claim's outcome and the actions that follow it. A
 * claim with no action that could follow is left out.
 */
const planRunCarry = ({
  runId,
  workspaceId,
  sourceRunId,
  sourceClaims,
  sourceEvents,
  targetClaims,
}: {
  runId: SafeId<"legalListVerificationRun">;
  workspaceId: SafeId<"workspace">;
  sourceRunId: SafeId<"legalListVerificationRun">;
  sourceClaims: readonly SourceClaim[];
  sourceEvents: ReadonlyMap<SafeId<"legalListClaim">, CarriedSourceEvent[]>;
  targetClaims: readonly SourceClaim[];
}): CarryRow[] => {
  const matches = matchClaims(sourceClaims, targetClaims);
  const targets = new Map(targetClaims.map((claim) => [claim.id, claim]));
  const base = { workspaceId, runId, sourceRunId };
  return sourceClaims.flatMap((claim): CarryRow[] => {
    const events = sourceEvents.get(claim.id);
    if (
      events === undefined ||
      !events.some(
        (event) => CLAIM_REVIEW_CARRY_RULE[event.payload.kind] !== "never",
      )
    ) {
      return [];
    }
    const match =
      matches.get(claim.id) ?? panic("A source claim has no match outcome");
    switch (match.type) {
      case "unmatched":
      case "ambiguous": {
        return [
          {
            outcome: {
              ...base,
              sourceClaimId: claim.id,
              outcome: match.type,
              targetClaimId: null,
            },
            events: [],
          },
        ];
      }
      case "matched":
      case "changed-text": {
        const target =
          targets.get(match.targetId) ??
          panic("A claim matched outside the new run");
        const plan =
          planClaimCarry({
            source: claim,
            events,
            target,
            wording: match.type === "matched" ? "same" : "edited",
          }) ?? panic("A reviewed claim has nothing to plan");
        return [
          {
            outcome: {
              ...base,
              sourceClaimId: claim.id,
              outcome: plan.outcome,
              targetClaimId: target.id,
            },
            events: plan.events,
          },
        ];
      }
      default: {
        match satisfies never;
        return panic(`Unhandled claim match: ${String(match)}`);
      }
    }
  });
};

/**
 * A carried copy of a stored action. Actions recorded before reasons were
 * required may lack one their kind now requires; the copy keeps the payload
 * as written, and the reason check admits it because the row names its
 * origin (`carried_from_event_id`).
 */
const carriedPayload = (
  payload: StoredClaimReviewEventPayload,
): ClaimReviewEventPayload =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a carried copy keeps its origin's payload as written; the database admits it by its origin
  payload as ClaimReviewEventPayload;

type CarryReviewsArgs = {
  tx: Pick<PgAsyncDatabase<PgQueryResultHKT>, "select" | "insert">;
  runId: SafeId<"legalListVerificationRun">;
  workspaceId: SafeId<"workspace">;
};

/**
 * Carry the previous run's review to this run's claims, which must already
 * be written. Returns how many source claims got an outcome row now.
 */
export const carryReviewsToRun = async ({
  tx,
  runId,
  workspaceId,
}: CarryReviewsArgs): Promise<number> => {
  const run = (
    await tx
      .select({
        id: legalListVerificationRuns.id,
        workspaceId: legalListVerificationRuns.workspaceId,
        entityId: legalListVerificationRuns.entityId,
        fileFieldId: legalListVerificationRuns.fileFieldId,
        listId: verificationRunListIdColumn,
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
    return 0;
  }
  const source = (
    await tx
      .select({ id: legalListVerificationRuns.id })
      .from(legalListVerificationRuns)
      .where(
        and(
          eq(legalListVerificationRuns.workspaceId, run.workspaceId),
          eq(legalListVerificationRuns.entityId, run.entityId),
          eq(legalListVerificationRuns.fileFieldId, run.fileFieldId),
          eq(legalListVerificationRuns.status, "completed"),
          ne(legalListVerificationRuns.id, run.id),
          eq(verificationRunListIdColumn, run.listId),
        ),
      )
      .orderBy(
        desc(legalListVerificationRuns.createdAt),
        desc(legalListVerificationRuns.id),
      )
      .limit(1)
  ).at(0);
  if (source === undefined) {
    return 0;
  }
  // Bounded by what the writers allow: claims per run, actions per claim.
  // A read past that would mean the bound broke; then nothing is carried
  // rather than half a review.
  const eventRead = await readBounded(
    tx
      .select({
        id: legalListClaimReviewEvents.id,
        claimId: legalListClaimReviewEvents.claimId,
        payload: legalListClaimReviewEvents.payload,
        actorId: legalListClaimReviewEvents.actorId,
        createdAt: legalListClaimReviewEvents.createdAt,
      })
      .from(legalListClaimReviewEvents)
      .where(
        and(
          eq(legalListClaimReviewEvents.workspaceId, run.workspaceId),
          eq(legalListClaimReviewEvents.runId, source.id),
        ),
      )
      // The fold's order, as `readClaimReviews` reads it.
      .orderBy(
        asc(legalListClaimReviewEvents.createdAt),
        asc(legalListClaimReviewEvents.id),
      ),
    VERIFICATION_LIMITS.CLAIMS_PER_RUN_MAX *
      VERIFICATION_LIMITS.REVIEW_EVENTS_PER_CLAIM_MAX,
  );
  if (eventRead.type === "overflow" || eventRead.rows.length === 0) {
    return 0;
  }
  const events = eventRead.rows;
  const claimColumns = {
    id: legalListClaims.id,
    text: legalListClaims.text,
    anchor: legalListClaims.anchor,
    state: legalListClaims.state,
    recordConflict: legalListClaims.recordConflict,
  };
  // Claims per run are capped by their position check.
  const readClaims = async (ofRun: SafeId<"legalListVerificationRun">) =>
    await readBounded(
      tx
        .select(claimColumns)
        .from(legalListClaims)
        .where(
          and(
            eq(legalListClaims.workspaceId, run.workspaceId),
            eq(legalListClaims.runId, ofRun),
          ),
        )
        .orderBy(asc(legalListClaims.position)),
      VERIFICATION_LIMITS.CLAIMS_PER_RUN_MAX,
    );
  const sourceRead = await readClaims(source.id);
  const targetRead = await readClaims(run.id);
  if (sourceRead.type === "overflow" || targetRead.type === "overflow") {
    return 0;
  }
  const sourceClaims = sourceRead.rows;
  const targetClaims = targetRead.rows;

  const sourceEvents = new Map<
    SafeId<"legalListClaim">,
    CarriedSourceEvent[]
  >();
  for (const { claimId, ...event } of events) {
    // Rows from before reasons were required carry none; the stored shape
    // says so, and the copy keeps it.
    const stored: CarriedSourceEvent = event;
    const bucket = sourceEvents.get(claimId);
    if (bucket === undefined) {
      sourceEvents.set(claimId, [stored]);
    } else {
      bucket.push(stored);
    }
  }
  const rows = planRunCarry({
    runId: run.id,
    workspaceId: run.workspaceId,
    sourceRunId: source.id,
    sourceClaims,
    sourceEvents,
    targetClaims,
  });

  // Outcome rows first: only a source claim whose row is new has its
  // actions written, so a replay converges on what the first pass wrote.
  const fresh = new Set<SafeId<"legalListClaim">>();
  await insertInChunks(rows, async (batch) => {
    // audit: skip — carried review shares the completion audit in this transaction.
    const written = await tx
      .insert(legalListClaimCarryOutcomes)
      .values(batch.map((row) => row.outcome))
      .onConflictDoNothing({
        target: [
          legalListClaimCarryOutcomes.runId,
          legalListClaimCarryOutcomes.sourceClaimId,
        ],
      })
      .returning({ sourceClaimId: legalListClaimCarryOutcomes.sourceClaimId });
    for (const { sourceClaimId } of written) {
      fresh.add(sourceClaimId);
    }
  });
  const carried = rows.flatMap(({ outcome, events: carriedEvents }) => {
    const targetClaimId = outcome.targetClaimId;
    return targetClaimId === null ||
      targetClaimId === undefined ||
      !fresh.has(outcome.sourceClaimId)
      ? []
      : carriedEvents.map((event) => ({
          id: createSafeId<"legalListClaimReviewEvent">(),
          workspaceId: run.workspaceId,
          runId: run.id,
          claimId: targetClaimId,
          kind: event.payload.kind,
          payload: carriedPayload(event.payload),
          actorId: event.actorId,
          createdAt: event.createdAt,
          carriedFromRunId: source.id,
          carriedFromEventId: event.id,
        }));
  });
  await insertInChunks(
    carried,
    async (batch) =>
      // audit: skip — carried review shares the completion audit in this transaction.
      await tx.insert(legalListClaimReviewEvents).values(batch),
  );
  return fresh.size;
};
