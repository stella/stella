/**
 * Re-check claims of one run: grade them again against their list's facts
 * as they stand now, each with the facts a reviewer pointed it at.
 *
 * Claims are immutable once their run writes them, so a re-check is a
 * reviewer event: it records who asked, the grade it got, and the facts the
 * grade was read against (as their difference from the run's pinned facts).
 * The claim is read with its latest re-check's grade from then on
 * (`gradeOf`); its run's grade stays on the row and in the history.
 *
 * One claim and many go through the same path: one read of what grading
 * needs, the grader in batches (`gradeClaims`, one model call per batch, so
 * a batch that fails fails only its own claims), and one write that locks
 * every graded claim in id order. The model calls run between the two short
 * transactions, never inside one. The claims' row locks serialize the
 * write, so a repeated request key finds the event the first request wrote
 * and nothing is graded twice once it landed.
 */

import { panic, Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import { VERIFICATION_RECHECKS_PER_REQUEST_MAX } from "@stll/api-contract/verification-rechecks";
import { mapWithConcurrency } from "@stll/concurrency";
import { chunk as chunkItems } from "@stll/concurrency/chunk";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { legalListClaimReviewEvents } from "@/api/db/schema";
import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-config";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { writeGraphEdges } from "@/api/lib/lists/graph/edge-writer";
import type { ListVerificationAccessProof } from "@/api/lib/lists/verification/access";
import { resolveListVerificationAccess } from "@/api/lib/lists/verification/access-context";
import {
  gradeClaims,
  GRADING_BATCH_SIZE,
  GRADING_CONCURRENCY,
} from "@/api/lib/lists/verification/claim-grade";
import { VERIFICATION_LIMITS } from "@/api/lib/lists/verification/contract";
import type {
  ClaimAssertedDate,
  ClaimGrade,
  ClaimReviewEventPayload,
  ClaimState,
  RecordConflict,
  VerificationEvidenceFact,
} from "@/api/lib/lists/verification/contract";
import { readVerificationEvidence } from "@/api/lib/lists/verification/evidence";
import {
  ListVerificationAccessRevokedError,
  VERIFICATION_MODEL_TASK,
} from "@/api/lib/lists/verification/model-call";
import type { VerificationModelDeps } from "@/api/lib/lists/verification/model-call";
import {
  readClaimReviews,
  readClaimsForBulkReview,
  readRecheckTargets,
} from "@/api/lib/lists/verification/read-run";
import { factChangesFrom } from "@/api/lib/lists/verification/recheck-facts";
import {
  EMPTY_CLAIM_REVIEW,
  rejectRecheck,
} from "@/api/lib/lists/verification/review-fold";
import type { VerificationRunCaps } from "@/api/lib/lists/verification/run-cap-config";
import {
  checkVerificationRecheckBudget,
  ListVerificationRunCapError,
} from "@/api/lib/lists/verification/run-caps";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import {
  formatModelRef,
  getTanStackTextModelInfoForTask,
} from "@/api/lib/tanstack-ai-models";

/** One round of grading calls: a request re-checks at most as many claims
 *  as the grader takes in its batches at once, so it waits for one call. */
export const RECHECKS_PER_REQUEST_MAX = VERIFICATION_RECHECKS_PER_REQUEST_MAX;

/** One round of grading calls, and one repair round at most. */
const RECHECK_TIMEOUT_MS = 90_000;
const SERVICE_TIER = "standard" as const satisfies AIRequestServiceTier;

type RecheckScope = {
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"legalListVerificationRun">;
};

/** One claim to grade again, under the key its request is repeated with. */
export type RecheckRequest = {
  claimId: SafeId<"legalListClaim">;
  requestKey: string;
};

/** The claims among `requests` whose key already wrote a re-check. Bounded
 *  by the claims' action caps and served by the claim index. */
const findReplayed = async (
  tx: Pick<Transaction, "select">,
  { workspaceId, runId }: RecheckScope,
  requests: readonly RecheckRequest[],
): Promise<Set<SafeId<"legalListClaim">>> => {
  if (requests.length === 0) {
    return new Set();
  }
  const keyOf = new Map(
    requests.map((request) => [request.claimId, request.requestKey]),
  );
  const events = await tx
    .select({
      claimId: legalListClaimReviewEvents.claimId,
      payload: legalListClaimReviewEvents.payload,
    })
    .from(legalListClaimReviewEvents)
    .where(
      and(
        eq(legalListClaimReviewEvents.workspaceId, workspaceId),
        eq(legalListClaimReviewEvents.runId, runId),
        inArray(legalListClaimReviewEvents.claimId, [...keyOf.keys()]),
        eq(legalListClaimReviewEvents.kind, "recheck"),
      ),
    )
    .limit(requests.length * VERIFICATION_LIMITS.REVIEW_EVENTS_PER_CLAIM_MAX);
  return new Set(
    events
      .filter(
        ({ claimId, payload }) =>
          payload.kind === "recheck" &&
          payload.requestKey === keyOf.get(claimId),
      )
      .map(({ claimId }) => claimId),
  );
};

type RecheckCommon = RecheckScope & {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  admission: ModelDispatchAdmission;
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
  promptCachingEnabled: boolean;
  recordAuditEvent: AuditRecorder;
  signal: AbortSignal;
  caps?: VerificationRunCaps;
  /** External model-dispatch boundary; supplied by focused tests. */
  generateObjectForTask?: VerificationModelDeps["generateObjectForTask"];
};

export type RecheckClaimsArgs = RecheckCommon & {
  /** Distinct claims, at most `RECHECKS_PER_REQUEST_MAX`. */
  requests: readonly RecheckRequest[];
};

export type RecheckClaimArgs = RecheckCommon & RecheckRequest;

/** Why a re-check was not recorded, when the request itself was sound. */
export type RecheckRefusal =
  | { type: "not-found" }
  | { type: "too-many-actions" }
  | { type: "recheck-set-aside-claim" }
  | { type: "superseded" }
  | { type: "too-many-facts" }
  | { type: "access-revoked" }
  | { type: "run-limit"; error: ListVerificationRunCapError }
  | { type: "grading-failed"; cause: unknown };

export type RecheckOutcome =
  { type: "rechecked"; replayed: boolean } | RecheckRefusal;

type ReviewTarget = {
  state: ClaimState;
  recordConflict: RecordConflict | null;
};

type ReviewRecords = Awaited<ReturnType<typeof readClaimReviews>>;

/** Whether the claim can take one more review action now, or why not. */
const reviewAdmits = (
  claimId: SafeId<"legalListClaim">,
  claim: ReviewTarget,
  records: ReviewRecords,
) => {
  const record = records.get(claimId);
  const eventCount = record?.eventCount ?? 0;
  if (eventCount >= VERIFICATION_LIMITS.REVIEW_EVENTS_PER_CLAIM_MAX) {
    return { type: "too-many-actions" } as const;
  }
  const review = record?.review ?? EMPTY_CLAIM_REVIEW;
  const rejection = rejectRecheck(claim, review);
  return rejection === null
    ? ({ type: "admitted", review, eventCount } as const)
    : ({ type: rejection } as const);
};

/** One claim ready to grade: what the grader reads of it. */
type ReadyClaim = RecheckRequest & {
  text: string;
  /** The claim's block as the run's grading read it, cut to its range. */
  context: { text: string; anchor: { start: number; end: number } };
  linkedFactIds: readonly SafeId<"entity">[];
  /** The claim's review events when grading began; any added since (a link,
   *  another re-check) means this grade answers a question no longer asked. */
  eventCount: number;
};

/** What grading reads, gathered before any model call, with the outcome of
 *  every claim that needs none. */
type Prepared = {
  outcomes: Map<SafeId<"legalListClaim">, RecheckOutcome>;
  ready: ReadyClaim[];
  pinned: readonly VerificationEvidenceFact[];
  current: readonly VerificationEvidenceFact[];
  entityVersionId: SafeId<"entityVersion"> | null;
};

const prepareRechecks = async (
  args: RecheckClaimsArgs,
): Promise<Result<Prepared, SafeDbError>> => {
  const scope = { workspaceId: args.workspaceId, runId: args.runId };
  return await args.safeDb(async (tx): Promise<Prepared> => {
    const outcomes = new Map<SafeId<"legalListClaim">, RecheckOutcome>();
    const replayed = await findReplayed(tx, scope, args.requests);
    for (const claimId of replayed) {
      outcomes.set(claimId, { type: "rechecked", replayed: true });
    }
    const asked = args.requests.filter(
      (request) => !replayed.has(request.claimId),
    );
    const targets = await readRecheckTargets({
      ...scope,
      tx,
      claimIds: asked.map((request) => request.claimId),
    });
    const records = await readClaimReviews({
      ...scope,
      tx,
      claimIds: asked.map((request) => request.claimId),
    });
    const admitted: ReadyClaim[] = [];
    for (const request of asked) {
      const target = targets?.claims.get(request.claimId);
      if (target === undefined) {
        outcomes.set(request.claimId, { type: "not-found" });
        continue;
      }
      const decision = reviewAdmits(request.claimId, target, records);
      if (decision.type !== "admitted") {
        outcomes.set(request.claimId, decision);
        continue;
      }
      admitted.push({
        ...request,
        text: target.text,
        context: target.context,
        linkedFactIds: decision.review.linkedFactIds,
        eventCount: decision.eventCount,
      });
    }
    if (targets === null || admitted.length === 0) {
      return {
        outcomes,
        ready: [],
        pinned: [],
        current: [],
        entityVersionId: null,
      };
    }
    const evidence = await readVerificationEvidence({
      tx,
      workspaceId: args.workspaceId,
      listId: targets.evidence.listId,
    });
    if (evidence.type === "too-many-facts") {
      for (const claim of admitted) {
        outcomes.set(claim.claimId, { type: "too-many-facts" });
      }
      return {
        outcomes,
        ready: [],
        pinned: [],
        current: [],
        entityVersionId: null,
      };
    }
    return {
      outcomes,
      ready: admitted,
      pinned: targets.evidence.facts,
      current: evidence.evidence.facts,
      entityVersionId: targets.entityVersionId,
    };
  });
};

type GradeRechecksArgs = {
  args: RecheckClaimsArgs;
  prepared: Prepared & { entityVersionId: SafeId<"entityVersion"> };
  accessProof: ListVerificationAccessProof;
  resolveAccess: () => Promise<ListVerificationAccessProof | null>;
};

/** A claim's new grade and the date its grading read. */
type RecheckGrading = { grade: ClaimGrade; assertedOn: ClaimAssertedDate };

/** Why a batch's grading failed, as each of its claims reports it. */
const gradingRefusal = (cause: unknown): RecheckRefusal => {
  if (cause instanceof ListVerificationRunCapError) {
    return { type: "run-limit", error: cause };
  }
  if (cause instanceof ListVerificationAccessRevokedError) {
    return { type: "access-revoked" };
  }
  return { type: "grading-failed", cause };
};

/** Grade the ready claims through the same call and budget a run uses, one
 *  model call per batch; a claim gets its grade or why it has none. */
const gradeRechecks = async ({
  args,
  prepared,
  accessProof,
  resolveAccess,
}: GradeRechecksArgs): Promise<
  Map<SafeId<"legalListClaim">, RecheckGrading | RecheckRefusal>
> => {
  const { safeDb, organizationId, workspaceId, userId } = args;
  const deps: VerificationModelDeps = {
    admission: args.admission,
    accessProof,
    refreshAccessProof: resolveAccess,
    // A budget that cannot be read fails the grading, as in a run.
    checkRunBudget: async () =>
      (
        await safeDb(
          async (tx) =>
            await checkVerificationRecheckBudget({
              tx,
              organizationId,
              ...(args.caps === undefined ? {} : { caps: args.caps }),
            }),
        )
      ).unwrap("The verification budget could not be read."),
    organizationId,
    workspaceId,
    entityVersionId: prepared.entityVersionId,
    orgAIConfig: args.orgAIConfig,
    managedAIResidency: args.managedAIResidency,
    promptCachingEnabled: args.promptCachingEnabled,
    serviceTier: SERVICE_TIER,
    usageMetering: {
      actionType: "doc_review",
      organizationId,
      safeDb,
      serviceTier: SERVICE_TIER,
      userId,
      workspaceId,
    },
    abortSignal: AbortSignal.any([
      args.signal,
      AbortSignal.timeout(RECHECK_TIMEOUT_MS),
    ]),
    ...(args.generateObjectForTask === undefined
      ? {}
      : { generateObjectForTask: args.generateObjectForTask }),
  };
  const perBatch = await mapWithConcurrency({
    items: chunkItems(prepared.ready, GRADING_BATCH_SIZE),
    limit: GRADING_CONCURRENCY,
    operation: async (batch) => ({
      batch,
      graded: await gradeClaims({
        claims: batch.map((claim) => ({
          key: claim.claimId,
          text: claim.text,
          context: claim.context,
          linkedFactIds: claim.linkedFactIds,
        })),
        facts: prepared.current,
        deps,
      }),
    }),
  });
  const results = new Map<
    SafeId<"legalListClaim">,
    RecheckGrading | RecheckRefusal
  >();
  for (const { batch, graded } of perBatch) {
    for (const claim of batch) {
      if (Result.isError(graded)) {
        results.set(claim.claimId, gradingRefusal(graded.error.cause));
        continue;
      }
      // A claim the grader left unanswered, even after its repair round,
      // fails alone; the batch's answered claims keep their grades.
      const grade = graded.value.grades.get(claim.claimId);
      const assertedOn = graded.value.assertedDates.get(claim.claimId);
      results.set(
        claim.claimId,
        grade === undefined || assertedOn === undefined
          ? { type: "grading-failed", cause: graded.value }
          : { grade, assertedOn },
      );
    }
  }
  return results;
};

type GradedClaim = { claim: ReadyClaim } & RecheckGrading;

type RecordRechecksArgs = {
  args: RecheckClaimsArgs;
  prepared: Prepared;
  graded: readonly GradedClaim[];
  modelRef: string | null;
};

/** Append each graded claim's re-check, unless the claim changed under its
 *  grading; the outcome of every claim it was given. */
const recordRechecks = async ({
  args,
  prepared,
  graded,
  modelRef,
}: RecordRechecksArgs): Promise<
  Result<Map<SafeId<"legalListClaim">, RecheckOutcome>, SafeDbError>
> => {
  const scope = { workspaceId: args.workspaceId, runId: args.runId };
  return await args.safeDb(async (tx) => {
    const outcomes = new Map<SafeId<"legalListClaim">, RecheckOutcome>();
    const claimIds = graded.map(({ claim }) => claim.claimId);
    // Locking the claims, in the id order every bulk writer shares,
    // serializes every writer of their events, so the keys and caps checked
    // here are the ones the inserts land against.
    const locked = new Map(
      (await readClaimsForBulkReview({ ...scope, tx, claimIds })).map(
        (claim) => [claim.id, claim],
      ),
    );
    const replayed = await findReplayed(
      tx,
      scope,
      graded.map(({ claim }) => claim),
    );
    const records = await readClaimReviews({ ...scope, tx, claimIds });
    const writable: GradedClaim[] = [];
    for (const entry of graded) {
      const { claimId } = entry.claim;
      const row = locked.get(claimId);
      if (row === undefined) {
        outcomes.set(claimId, { type: "not-found" });
        continue;
      }
      if (replayed.has(claimId)) {
        outcomes.set(claimId, { type: "rechecked", replayed: true });
        continue;
      }
      const decision = reviewAdmits(claimId, row, records);
      if (decision.type !== "admitted") {
        outcomes.set(claimId, decision);
        continue;
      }
      if (decision.eventCount !== entry.claim.eventCount) {
        outcomes.set(claimId, { type: "superseded" });
        continue;
      }
      writable.push(entry);
    }
    if (writable.length === 0) {
      return outcomes;
    }
    // Access is read again with the write: a grant withdrawn while the
    // claims were graded records nothing and withdraws no decision.
    const access = await resolveListVerificationAccess({
      tx,
      organizationId: args.organizationId,
      workspaceId: args.workspaceId,
      userId: args.userId,
    });
    if (access.status === "unavailable") {
      for (const { claim } of writable) {
        outcomes.set(claim.claimId, { type: "access-revoked" });
      }
      return outcomes;
    }
    const facts = factChangesFrom(prepared.pinned, prepared.current);
    const events = writable.map(({ claim, grade, assertedOn }) => {
      const payload = {
        kind: "recheck",
        requestKey: claim.requestKey,
        grade,
        facts,
        modelRef,
        assertedOn,
      } as const satisfies ClaimReviewEventPayload;
      return {
        ...scope,
        claimId: claim.claimId,
        id: createSafeId<"legalListClaimReviewEvent">(),
        kind: payload.kind,
        payload,
        actorId: args.userId,
      };
    });
    await tx.insert(legalListClaimReviewEvents).values(events);
    await writeGraphEdges(tx, args.workspaceId, {
      type: "recheck",
      eventIds: events.map((event) => event.id),
    });
    await args.recordAuditEvent(tx, {
      action: AUDIT_ACTION.REVIEW,
      resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_VERIFICATION,
      resourceId: args.runId,
      metadata: {
        kind: "recheck",
        factCount: prepared.current.length,
        claims: events.map((event) => ({
          claimId: event.claimId,
          eventId: event.id,
          state: event.payload.grade.state,
        })),
      },
    });
    for (const { claim } of writable) {
      outcomes.set(claim.claimId, { type: "rechecked", replayed: false });
    }
    return outcomes;
  });
};

/**
 * Re-check claims of one run, or say per claim why one was not. Every
 * requested claim has an outcome. An organization at its verification
 * limit is refused before any model call, each claim with `run-limit`.
 */
export const recheckClaims = async (
  args: RecheckClaimsArgs,
): Promise<
  Result<Map<SafeId<"legalListClaim">, RecheckOutcome>, SafeDbError>
> => {
  const prepared = await prepareRechecks(args);
  if (Result.isError(prepared)) {
    return prepared;
  }
  const { outcomes, ready, current, entityVersionId } = prepared.value;
  if (ready.length === 0 || entityVersionId === null) {
    return Result.ok(outcomes);
  }
  const refuseReady = (refusal: RecheckRefusal) => {
    for (const claim of ready) {
      outcomes.set(claim.claimId, refusal);
    }
    return Result.ok(outcomes);
  };

  // The model resolves before any call, as a run's does: an organization
  // that cannot run it is refused before grading, and the events name the
  // model the grades came from. None is called without facts to check.
  const modelRef =
    current.length === 0
      ? null
      : formatModelRef(
          getTanStackTextModelInfoForTask(
            VERIFICATION_MODEL_TASK,
            args.orgAIConfig,
            {
              dataClass: "customer",
              organizationId: args.organizationId,
              modelTier: args.admission.modelTier,
            },
          ),
        );

  const readAccess = async () =>
    await args.safeDb(
      async (tx) =>
        await resolveListVerificationAccess({
          tx,
          organizationId: args.organizationId,
          workspaceId: args.workspaceId,
          userId: args.userId,
        }),
    );
  const access = await readAccess();
  if (Result.isError(access)) {
    return access;
  }
  if (access.value.status === "unavailable") {
    return refuseReady({ type: "access-revoked" });
  }
  // One read of the budget refuses the whole request before any model call;
  // every call checks it again, as a run's do.
  if (current.length > 0) {
    const budget = await args.safeDb(
      async (tx) =>
        await checkVerificationRecheckBudget({
          tx,
          organizationId: args.organizationId,
          ...(args.caps === undefined ? {} : { caps: args.caps }),
        }),
    );
    if (Result.isError(budget)) {
      return budget;
    }
    if (Result.isError(budget.value)) {
      return refuseReady({ type: "run-limit", error: budget.value.error });
    }
  }

  const grades = await gradeRechecks({
    args,
    prepared: { ...prepared.value, entityVersionId },
    accessProof: access.value.proof,
    // Read again before each model call; one that cannot be read stops the
    // grading as revoked access would.
    resolveAccess: async () => {
      const decision = await readAccess();
      return Result.isOk(decision) && decision.value.status === "available"
        ? decision.value.proof
        : null;
    },
  });
  const graded: GradedClaim[] = [];
  for (const claim of ready) {
    const result =
      grades.get(claim.claimId) ?? panic("A ready claim has no grading result");
    if ("type" in result) {
      outcomes.set(claim.claimId, result);
    } else {
      graded.push({ claim, ...result });
    }
  }
  if (graded.length === 0) {
    return Result.ok(outcomes);
  }
  const recorded = await recordRechecks({
    args,
    prepared: prepared.value,
    graded,
    modelRef,
  });
  if (Result.isError(recorded)) {
    return recorded;
  }
  for (const [claimId, outcome] of recorded.value) {
    outcomes.set(claimId, outcome);
  }
  return Result.ok(outcomes);
};

/** Re-check one claim, or say why it was not. */
export const recheckClaim = async ({
  claimId,
  requestKey,
  ...common
}: RecheckClaimArgs): Promise<Result<RecheckOutcome, SafeDbError>> => {
  const outcomes = await recheckClaims({
    ...common,
    requests: [{ claimId, requestKey }],
  });
  return outcomes.map(
    (byClaim) =>
      byClaim.get(claimId) ?? panic("A requested claim has no outcome"),
  );
};
