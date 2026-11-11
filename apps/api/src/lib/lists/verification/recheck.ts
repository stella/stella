/**
 * Re-check one claim: grade it again against its list's facts as they stand
 * now, with the facts a reviewer pointed it at.
 *
 * Claims are immutable once their run writes them, so a re-check is a
 * reviewer event: it records who asked, the grade it got, and the facts the
 * grade was read against (as their difference from the run's pinned facts).
 * The claim is read with its latest re-check's grade from then on
 * (`gradeOf`); its run's grade stays on the row and in the history.
 *
 * The model call runs between two short transactions, never inside one. The
 * claim's row lock serializes the write, so a repeated request key finds the
 * event the first request wrote and nothing is graded twice once it landed.
 */

import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { legalListClaimReviewEvents } from "@/api/db/schema";
import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-config";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import type { ListVerificationAccessProof } from "@/api/lib/lists/verification/access";
import { resolveListVerificationAccess } from "@/api/lib/lists/verification/access-context";
import { gradeClaims } from "@/api/lib/lists/verification/claim-grade";
import { VERIFICATION_LIMITS } from "@/api/lib/lists/verification/contract";
import type {
  ClaimAnchor,
  ClaimGrade,
  ClaimReviewEventPayload,
  VerificationEvidenceFact,
} from "@/api/lib/lists/verification/contract";
import { readVerificationEvidence } from "@/api/lib/lists/verification/evidence";
import {
  ListVerificationAccessRevokedError,
  VERIFICATION_MODEL_TASK,
} from "@/api/lib/lists/verification/model-call";
import type { VerificationModelDeps } from "@/api/lib/lists/verification/model-call";
import {
  readClaimForReview,
  readClaimReviews,
  readRecheckTarget,
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

/** One claim is one grading call, and one repair round at most. */
const RECHECK_TIMEOUT_MS = 90_000;
const SERVICE_TIER = "standard" as const satisfies AIRequestServiceTier;

type RecheckRef = {
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"legalListVerificationRun">;
  claimId: SafeId<"legalListClaim">;
};

/** The recheck event a request key already wrote for this claim, if any.
 *  Bounded by the claim's action cap and served by its claim index. */
const findRecheckByKey = async (
  tx: Pick<Transaction, "select">,
  { workspaceId, runId, claimId }: RecheckRef,
  requestKey: string,
) =>
  (
    await tx
      .select({ id: legalListClaimReviewEvents.id })
      .from(legalListClaimReviewEvents)
      .where(
        and(
          eq(legalListClaimReviewEvents.workspaceId, workspaceId),
          eq(legalListClaimReviewEvents.claimId, claimId),
          eq(legalListClaimReviewEvents.runId, runId),
          eq(legalListClaimReviewEvents.kind, "recheck"),
          sql`${legalListClaimReviewEvents.payload} ->> 'requestKey' = ${requestKey}`,
        ),
      )
      .limit(1)
  ).at(0);

export type RecheckClaimArgs = RecheckRef & {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  requestKey: string;
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

/** Why a re-check was not recorded, when the request itself was sound. */
export type RecheckRefusal =
  | { type: "not-found" }
  | { type: "too-many-actions" }
  | { type: "recheck-set-aside-claim" }
  | { type: "too-many-facts" }
  | { type: "access-revoked" }
  | { type: "run-limit"; error: ListVerificationRunCapError }
  | { type: "grading-failed"; cause: unknown };

export type RecheckOutcome =
  { type: "rechecked"; replayed: boolean } | RecheckRefusal;

/** What grading the claim reads, gathered before any model call. */
type RecheckInput = {
  pinned: readonly VerificationEvidenceFact[];
  current: readonly VerificationEvidenceFact[];
  entityVersionId: SafeId<"entityVersion">;
  text: string;
  blockText: string;
  anchor: ClaimAnchor;
  linkedFactIds: readonly SafeId<"entity">[];
};

/** Whether the claim can take one more review action now, or why not. */
const reviewAdmits = async (
  tx: Pick<Transaction, "select">,
  ref: RecheckRef,
  claim: Parameters<typeof rejectRecheck>[0],
) => {
  const record = (
    await readClaimReviews({ ...ref, tx, claimIds: [ref.claimId] })
  ).get(ref.claimId);
  if (
    (record?.eventCount ?? 0) >= VERIFICATION_LIMITS.REVIEW_EVENTS_PER_CLAIM_MAX
  ) {
    return { type: "too-many-actions" } as const;
  }
  const review = record?.review ?? EMPTY_CLAIM_REVIEW;
  const rejection = rejectRecheck(claim, review);
  return rejection === null
    ? ({ type: "admitted", review } as const)
    : ({ type: rejection } as const);
};

/** Read what grading needs, or the outcome that makes grading unneeded. */
const prepareRecheck = async (
  args: RecheckClaimArgs,
): Promise<
  Result<{ type: "ready"; input: RecheckInput } | RecheckOutcome, SafeDbError>
> => {
  const ref = {
    workspaceId: args.workspaceId,
    runId: args.runId,
    claimId: args.claimId,
  };
  return await args.safeDb(async (tx) => {
    if ((await findRecheckByKey(tx, ref, args.requestKey)) !== undefined) {
      return { type: "rechecked", replayed: true } as const;
    }
    const target = await readRecheckTarget({ ...ref, tx });
    if (target === null) {
      return { type: "not-found" } as const;
    }
    const admitted = await reviewAdmits(tx, ref, target.claim);
    if (admitted.type !== "admitted") {
      return admitted;
    }
    const evidence = await readVerificationEvidence({
      tx,
      workspaceId: args.workspaceId,
      listId: target.evidence.listId,
    });
    if (evidence.type === "too-many-facts") {
      return { type: "too-many-facts" } as const;
    }
    return {
      type: "ready",
      input: {
        pinned: target.evidence.facts,
        current: evidence.evidence.facts,
        entityVersionId: target.entityVersionId,
        text: target.claim.text,
        blockText: target.blockText,
        anchor: target.claim.anchor,
        linkedFactIds: admitted.review.linkedFactIds,
      },
    } as const;
  });
};

type GradeRecheckArgs = {
  args: RecheckClaimArgs;
  input: RecheckInput;
  accessProof: ListVerificationAccessProof;
  resolveAccess: () => Promise<ListVerificationAccessProof | null>;
};

/** Grade the one claim, through the same call and budget a run uses. */
const gradeRecheck = async ({
  args,
  input,
  accessProof,
  resolveAccess,
}: GradeRecheckArgs): Promise<
  { type: "graded"; grade: ClaimGrade } | RecheckRefusal
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
    entityVersionId: input.entityVersionId,
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
  const graded = await gradeClaims({
    claims: [
      {
        key: args.claimId,
        text: input.text,
        context: { text: input.blockText, anchor: input.anchor },
        linkedFactIds: input.linkedFactIds,
      },
    ],
    facts: input.current,
    deps,
  });
  if (Result.isError(graded)) {
    const cause: unknown = graded.error.cause;
    if (cause instanceof ListVerificationRunCapError) {
      return { type: "run-limit", error: cause };
    }
    if (cause instanceof ListVerificationAccessRevokedError) {
      return { type: "access-revoked" };
    }
    return { type: "grading-failed", cause };
  }
  const grade =
    graded.value.type === "graded"
      ? graded.value.grades.get(args.claimId)
      : undefined;
  return grade === undefined
    ? { type: "grading-failed", cause: graded.value }
    : { type: "graded", grade };
};

type RecordRecheckArgs = {
  args: RecheckClaimArgs;
  input: RecheckInput;
  grade: ClaimGrade;
  modelRef: string | null;
};

/** Append the re-check, unless the claim changed under the grading. */
const recordRecheck = async ({
  args,
  input,
  grade,
  modelRef,
}: RecordRecheckArgs): Promise<Result<RecheckOutcome, SafeDbError>> => {
  const ref = {
    workspaceId: args.workspaceId,
    runId: args.runId,
    claimId: args.claimId,
  };
  return await args.safeDb(async (tx): Promise<RecheckOutcome> => {
    // Locking the claim serializes every writer of its events, so the key
    // and the cap checked here are the ones the insert lands against.
    const claim = await readClaimForReview({ ...ref, tx });
    if (claim === undefined) {
      return { type: "not-found" };
    }
    if ((await findRecheckByKey(tx, ref, args.requestKey)) !== undefined) {
      return { type: "rechecked", replayed: true };
    }
    const admitted = await reviewAdmits(tx, ref, claim);
    if (admitted.type !== "admitted") {
      return admitted;
    }
    const payload = {
      kind: "recheck",
      requestKey: args.requestKey,
      grade,
      facts: factChangesFrom(input.pinned, input.current),
      modelRef,
    } as const satisfies ClaimReviewEventPayload;
    const eventId = createSafeId<"legalListClaimReviewEvent">();
    await tx.insert(legalListClaimReviewEvents).values({
      ...ref,
      id: eventId,
      kind: payload.kind,
      payload,
      actorId: args.userId,
    });
    await args.recordAuditEvent(tx, {
      action: AUDIT_ACTION.REVIEW,
      resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_VERIFICATION,
      resourceId: args.runId,
      metadata: {
        claimId: args.claimId,
        eventId,
        kind: payload.kind,
        state: grade.state,
        factCount: input.current.length,
      },
    });
    return { type: "rechecked", replayed: false };
  });
};

/** Re-check one claim, or say why it was not. */
export const recheckClaim = async (
  args: RecheckClaimArgs,
): Promise<Result<RecheckOutcome, SafeDbError>> => {
  const prepared = await prepareRecheck(args);
  if (Result.isError(prepared)) {
    return prepared;
  }
  if (prepared.value.type !== "ready") {
    return Result.ok(prepared.value);
  }
  const { input } = prepared.value;

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
    return Result.ok({ type: "access-revoked" });
  }

  const graded = await gradeRecheck({
    args,
    input,
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
  if (graded.type !== "graded") {
    return Result.ok(graded);
  }
  // No model is called when there are no facts to check against.
  const modelRef =
    input.current.length === 0
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
  return await recordRecheck({ args, input, grade: graded.grade, modelRef });
};
