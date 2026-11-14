/**
 * List verifications on the document run queue
 * (`@/api/lib/queue/document-run-queue`), which owns the one-shot skeleton:
 * one attempt, the run id as the job id, the time budget and the stuck rules.
 * This module keeps what is the verification's own: its table's reads and
 * transitions, the requester's access settled at every step, and the run.
 *
 * Convergence: only a `queued` row is claimable, and claims are written on
 * `(runId, position)` in one statement that ignores rows already there. A
 * re-delivered job is a no-op or rewrites nothing.
 */

import { panic, Result } from "better-result";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";

import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { legalListClaims } from "@/api/db/schema";
import { fields, legalListVerificationRuns } from "@/api/db/schema";
import { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { RequeueableQueue } from "@/api/lib/bullmq-requeue";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import type { ListVerificationAccessProof } from "@/api/lib/lists/verification/access";
import { resolveListVerificationAccess } from "@/api/lib/lists/verification/access-context";
import {
  assertedDateColumns,
  claimAssertedDate,
} from "@/api/lib/lists/verification/claim-date";
import { extractClaims } from "@/api/lib/lists/verification/claim-extract";
import type { ExtractedClaim } from "@/api/lib/lists/verification/claim-extract";
import { gradeClaims } from "@/api/lib/lists/verification/claim-grade";
import {
  gradedClaimType,
  VERIFICATION_LIMITS,
  VERIFICATION_RUN_ACTIVE_STATUSES,
} from "@/api/lib/lists/verification/contract";
import type {
  ClaimAssertedDate,
  ClaimGrade,
  VerificationEvidence,
  VerificationRunErrorCode,
  VerificationScope,
} from "@/api/lib/lists/verification/contract";
import { readVerificationDocument } from "@/api/lib/lists/verification/document-text";
import type { VerificationBlock } from "@/api/lib/lists/verification/document-text";
import {
  ListVerificationAccessRevokedError,
  VERIFICATION_MODEL_TASK,
} from "@/api/lib/lists/verification/model-call";
import type { VerificationModelDeps } from "@/api/lib/lists/verification/model-call";
import {
  claimParagraphNumbers,
  passageContext,
  scopePassages,
} from "@/api/lib/lists/verification/paragraph-scope";
import { readRunEvidenceForGrading } from "@/api/lib/lists/verification/read-run";
import {
  completeVerificationRun,
  failVerificationRun,
} from "@/api/lib/lists/verification/run-persistence";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  RECONCILE_SCAN_PAGE_SIZE,
  reconcileCursorTimestamp,
  scanPendingRows,
} from "@/api/lib/queue-reconcile-scan";
import {
  createDocumentRunJobs,
  createDocumentRunQueue,
  STANDARD_DOCUMENT_RUN_LIMITS,
} from "@/api/lib/queue/document-run-queue";
import type {
  DocumentRunExecute,
  DocumentRunJobData,
  EnqueueDocumentRunArgs,
  StuckRunAges,
} from "@/api/lib/queue/document-run-queue";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import type { RootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedListVerificationRunId } from "@/api/lib/safe-id-boundaries";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import {
  formatModelRef,
  getTanStackTextModelInfoForTask,
} from "@/api/lib/tanstack-ai-models";
import {
  checkModelRunCaps,
  ModelRunCapError,
} from "@/api/lib/usage/model-run-caps/caps";

/** A verification's model calls re-check the list counter it was charged to. */
const VERIFICATION_DISPATCH_CAPS = {
  kind: "list-run",
  operation: "lists.verifications.create",
  phase: "dispatch",
} as const;

const CONFIG_FAILED_SINK = failureSink({
  event: "list_verification_run.config_failed",
  expected: [],
});
const SERVICE_TIER = "standard" as const;

/** What a sweep or a direct `processRun` call runs with. */
type VerificationQueueContext = {
  grants?: FeatureAccessGrants | undefined;
  execution?: VerificationExecutionBoundaries;
};

/** A worker runs with the deployment's own grants and real I/O. */
const WORKER_CONTEXT: VerificationQueueContext = {};

const runCursorCodec = createTimestampIdCursorCodec({
  column: legalListVerificationRuns.createdAt,
  brandId: brandPersistedListVerificationRunId,
});

type QueuedRunRow = Awaited<ReturnType<typeof readActiveRunPage>>[number];

const readActiveRunPage = async (
  db: Pick<SchedulerDb, "select">,
  cursor: {
    createdCursor: string;
    id: SafeId<"legalListVerificationRun">;
  } | null,
  status?: "queued",
) =>
  await db
    .select({
      createdCursor: runCursorCodec.cursorValue,
      createdAt: legalListVerificationRuns.createdAt,
      startedAt: legalListVerificationRuns.startedAt,
      status: legalListVerificationRuns.status,
      id: legalListVerificationRuns.id,
      organizationId: legalListVerificationRuns.organizationId,
      requestedBy: legalListVerificationRuns.requestedBy,
      workspaceId: legalListVerificationRuns.workspaceId,
    })
    .from(legalListVerificationRuns)
    .where(
      and(
        status === "queued"
          ? eq(legalListVerificationRuns.status, status)
          : inArray(legalListVerificationRuns.status, [
              ...VERIFICATION_RUN_ACTIVE_STATUSES,
            ]),
        cursor === null
          ? undefined
          : runCursorCodec.keysetAfter({
              cursor: {
                timestamp: reconcileCursorTimestamp(cursor.createdCursor),
                id: cursor.id,
              },
              idColumn: legalListVerificationRuns.id,
              direction: "ascending",
            }),
      ),
    )
    .orderBy(
      asc(legalListVerificationRuns.createdAt),
      asc(legalListVerificationRuns.id),
    )
    .limit(RECONCILE_SCAN_PAGE_SIZE);

type ResolvePersistedRunAccessArgs = {
  tx: Transaction;
  run: {
    id: SafeId<"legalListVerificationRun">;
    organizationId: SafeId<"organization">;
    workspaceId: SafeId<"workspace">;
  };
  grants?: FeatureAccessGrants | undefined;
  requesterId?: string;
  expectedStatus?: "running";
};

export const resolveListVerificationRunAccess = async ({
  tx,
  run,
  grants,
  requesterId,
  expectedStatus,
}: ResolvePersistedRunAccessArgs) => {
  const persisted = (
    await tx
      .select({
        requestedBy: legalListVerificationRuns.requestedBy,
        status: legalListVerificationRuns.status,
      })
      .from(legalListVerificationRuns)
      .where(
        and(
          eq(legalListVerificationRuns.id, run.id),
          eq(legalListVerificationRuns.organizationId, run.organizationId),
          eq(legalListVerificationRuns.workspaceId, run.workspaceId),
        ),
      )
      .limit(1)
      .for("update")
  ).at(0);
  if (
    persisted === undefined ||
    (persisted.status !== "queued" && persisted.status !== "running") ||
    (requesterId !== undefined && persisted.requestedBy !== requesterId) ||
    (expectedStatus !== undefined && persisted.status !== expectedStatus)
  ) {
    return { status: "unavailable" } as const;
  }
  return await resolveListVerificationAccess({
    tx,
    organizationId: run.organizationId,
    workspaceId: run.workspaceId,
    userId: persisted.requestedBy,
    grants,
  });
};

type ReconcileDb = Pick<SchedulerDb, "select" | "transaction">;

/**
 * Fail the runs older than the queue's stuck ages, and every active run whose
 * requester lost access: the row would otherwise hold its document's active
 * slot forever. Cross-workspace, so it runs on the scheduler's handle.
 */
const failStuckRuns = async ({
  db,
  stuck,
  context: { grants },
}: {
  db: ReconcileDb;
  stuck: StuckRunAges;
  context: VerificationQueueContext;
}): Promise<number> => {
  let recovered = 0;
  await scanPendingRows({
    readPage: async (cursor: QueuedRunRow | null) =>
      await readActiveRunPage(db, cursor),
    handle: async (run) => {
      const runningCutoff =
        Temporal.Now.instant().epochMilliseconds - stuck.runningMs;
      const queuedCutoff =
        Temporal.Now.instant().epochMilliseconds - stuck.queuedMs;
      const stale =
        run.status === "running"
          ? run.startedAt !== null && run.startedAt.getTime() < runningCutoff
          : run.createdAt.getTime() < queuedCutoff;
      const transitioned = await db.transaction(async (tx) => {
        const access = await resolveListVerificationRunAccess({
          tx,
          run,
          grants,
        });
        if (access.status === "available" && !stale) {
          return false;
        }
        return await failVerificationRun({
          tx,
          run,
          errorCode:
            access.status === "unavailable" ? "access_revoked" : "internal",
          expectedStatus: run.status === "running" ? "running" : "queued",
        });
      });
      if (transitioned) {
        recovered += 1;
      }
      return false;
    },
  });
  return recovered;
};

/**
 * Whether a `queued` run may be handed back to the queue. A run whose
 * requester lost access is closed instead, in the transaction that found it.
 */
const admitQueuedRun = async ({
  db,
  run,
  context: { grants },
}: {
  db: ReconcileDb;
  run: QueuedRunRow;
  context: VerificationQueueContext;
}): Promise<boolean> => {
  const access = await db.transaction(async (tx) => {
    const decision = await resolveListVerificationRunAccess({
      tx,
      run,
      grants,
    });
    if (decision.status === "unavailable") {
      await failVerificationRun({
        tx,
        run,
        errorCode: "access_revoked",
        expectedStatus: "queued",
      });
    }
    return decision;
  });
  return access.status === "available";
};

type RunActor = RootRunActor<"legalListVerificationRun">;

const brandActor = (data: DocumentRunJobData): RunActor =>
  createRootRunActor(data, brandPersistedListVerificationRunId);

type ClaimedRun = {
  fileFieldId: SafeId<"field">;
  entityVersionId: SafeId<"entityVersion">;
  contentSha256: string;
  scope: VerificationScope;
};

/** Conditional `queued -> running`: the loser of a double delivery updates
 *  nothing and stops. */
type ClaimRunArgs = {
  tx: Transaction;
  actor: RunActor;
  accessProof: ListVerificationAccessProof;
};

const claimRun = async ({
  tx,
  actor,
}: ClaimRunArgs): Promise<ClaimedRun | null> => {
  // audit: skip — claiming assigns execution; terminal transitions are audited.
  const rows = await tx
    .update(legalListVerificationRuns)
    .set({ status: "running", startedAt: new Date() })
    .where(
      and(
        eq(legalListVerificationRuns.id, actor.runId),
        eq(legalListVerificationRuns.workspaceId, actor.workspaceId),
        eq(legalListVerificationRuns.organizationId, actor.organizationId),
        eq(legalListVerificationRuns.requestedBy, actor.userId),
        eq(legalListVerificationRuns.status, "queued"),
      ),
    )
    .returning({
      fileFieldId: legalListVerificationRuns.fileFieldId,
      entityVersionId: legalListVerificationRuns.entityVersionId,
      contentSha256: legalListVerificationRuns.contentSha256,
      scope: legalListVerificationRuns.scope,
    });
  return rows.at(0) ?? null;
};

type SetRunFailedArgs = {
  actor: RunActor;
  errorCode: VerificationRunErrorCode;
  grants?: FeatureAccessGrants | undefined;
};
const setRunFailed = async ({
  actor,
  errorCode,
  grants,
}: SetRunFailedArgs): Promise<void> => {
  await actor.writeDb(async (tx) => {
    // The persisted requester is authoritative for both transition and audit.
    const owned = (
      await tx
        .select({ id: legalListVerificationRuns.id })
        .from(legalListVerificationRuns)
        .where(
          and(
            eq(legalListVerificationRuns.id, actor.runId),
            eq(legalListVerificationRuns.workspaceId, actor.workspaceId),
            eq(legalListVerificationRuns.organizationId, actor.organizationId),
            or(
              eq(legalListVerificationRuns.requestedBy, actor.userId),
              isNull(legalListVerificationRuns.requestedBy),
            ),
          ),
        )
        .limit(1)
        .for("update")
    ).at(0);
    if (owned === undefined) {
      return;
    }
    const access = await resolveListVerificationRunAccess({
      tx,
      run: {
        id: actor.runId,
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
      },
      requesterId: actor.userId,
      grants,
    });
    await failVerificationRun({
      tx,
      run: {
        id: actor.runId,
        workspaceId: actor.workspaceId,
        organizationId: actor.organizationId,
      },
      errorCode: access.status === "unavailable" ? "access_revoked" : errorCode,
    });
  });
};

type ResolvedFile = {
  fileId: string;
  mimeType: string;
  pdfFileId: string | null;
  sizeBytes: number;
};

/** The pinned file, or why it can no longer be read as pinned. Read under
 *  the requester's current membership: a requester who lost the matter
 *  resolves nothing, so the run stops before the document is read. */
const resolvePinnedFile = async (
  actor: RunActor,
  run: ClaimedRun,
): Promise<Result<ResolvedFile, VerificationRunErrorCode>> => {
  const row = (
    await actor.inputDb(
      async (tx) =>
        await tx
          .select({ content: fields.content })
          .from(fields)
          .where(
            and(
              eq(fields.workspaceId, actor.workspaceId),
              eq(fields.id, run.fileFieldId),
              eq(fields.entityVersionId, run.entityVersionId),
            ),
          )
          .limit(1),
    )
  ).at(0);
  if (row?.content.type !== "file") {
    return Result.err("pin_unresolved");
  }
  if (row.content.sha256Hex !== run.contentSha256) {
    return Result.err("pin_content_changed");
  }
  return Result.ok({
    fileId: row.content.id,
    mimeType: row.content.mimeType,
    pdfFileId: row.content.pdfFileId,
    sizeBytes: row.content.sizeBytes,
  });
};

type ClaimRow = typeof legalListClaims.$inferInsert;

type GradedClaims = {
  grades: ReadonlyMap<string, ClaimGrade>;
  assertedDates: ReadonlyMap<string, ClaimAssertedDate>;
};

/** One row per claim in reading order; a set-aside claim is never graded,
 *  so its date is read from its words alone. Each claim keeps the printed
 *  number of the paragraph it sits in, read from the whole document, so a
 *  range run numbers it as the document does. */
const claimRows = (
  actor: RunActor,
  claims: readonly ExtractedClaim[],
  { grades, assertedDates }: GradedClaims,
  documentBlocks: readonly VerificationBlock[],
): ClaimRow[] => {
  const paragraphOf = claimParagraphNumbers(documentBlocks);
  return claims.map((claim, position): ClaimRow => {
    const base = {
      id: createSafeId<"legalListClaim">(),
      workspaceId: actor.workspaceId,
      runId: actor.runId,
      position,
      type: claim.type,
      framing: claim.framing,
      text: claim.text,
      anchor: claim.anchor,
      ...assertedDateColumns(
        assertedDates.get(String(position)) ??
          claimAssertedDate(claim.text, null),
      ),
      paragraphNumber: paragraphOf(claim.anchor),
    };
    if (claim.type !== "fact") {
      return {
        ...base,
        state: "notverifiable",
        score: null,
        refs: [],
        recordConflict: null,
        qualifiers: [],
      };
    }
    const grade =
      grades.get(String(position)) ?? panic("A fact claim has no grade");
    return {
      ...base,
      type: gradedClaimType(grade),
      state: grade.state,
      score: grade.score,
      refs: grade.refs,
      recordConflict: grade.recordConflict,
      qualifiers: grade.qualifiers,
    };
  });
};

const resolveRunningActorAccess = async (
  actor: RunActor,
  grants?: FeatureAccessGrants,
) =>
  await actor.writeDb(
    async (tx) =>
      await resolveListVerificationRunAccess({
        tx,
        run: {
          id: actor.runId,
          organizationId: actor.organizationId,
          workspaceId: actor.workspaceId,
        },
        requesterId: actor.userId,
        expectedStatus: "running",
        grants,
      }),
  );

/** The text a run reads, or null when it may read none: more blocks than
 *  a run stores, or a stored range that no longer lands in the document (a
 *  range never widens to the whole document). Only the blocks the range
 *  reads are stored, so a range of a long document fits. */
const runPassages = (
  blocks: readonly VerificationBlock[],
  scope: VerificationScope,
) => {
  const passages = scopePassages(blocks, scope);
  return passages === null ||
    passages.length > VERIFICATION_LIMITS.BLOCKS_PER_RUN_MAX
    ? null
    : passages;
};

/** Trusted process-local I/O boundaries; never sourced from queued data. */
type VerificationExecutionBoundaries = {
  readDocument?: typeof readVerificationDocument;
  generateObjectForTask?: VerificationModelDeps["generateObjectForTask"];
};

/** Null on success, else the code the run failed with. */
type ExecuteRunArgs = {
  actor: RunActor;
  admission: ModelDispatchAdmission;
  run: ClaimedRun & { evidence: VerificationEvidence };
  accessProof: ListVerificationAccessProof;
  /** Starts the queue's time budget for the run. */
  deadline: () => AbortSignal;
  grants?: FeatureAccessGrants | undefined;
  execution?: VerificationExecutionBoundaries;
};

/** The passages a run checks with the document blocks they come from (which
 *  number the claims' paragraphs), or the code it fails with when the pinned
 *  file yields none. */
const readRunPassages = async ({
  actor,
  file,
  scope,
  readDocument,
  signal,
}: {
  actor: RunActor;
  file: ResolvedFile;
  scope: Parameters<typeof runPassages>[1];
  readDocument: typeof readVerificationDocument;
  signal: AbortSignal;
}): Promise<
  Result<
    {
      blocks: readonly VerificationBlock[];
      passages: NonNullable<ReturnType<typeof runPassages>>;
    },
    VerificationRunErrorCode
  >
> => {
  const document = await readDocument({
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    file,
    signal,
    // A run may wait out its own timeout for the document byte budget.
    admissionWaitMs: STANDARD_DOCUMENT_RUN_LIMITS.runTimeoutMs,
  });
  if (document.type === "unsupported-format") {
    return Result.err("unsupported_format");
  }
  if (document.type === "no-text") {
    return Result.err("no_text");
  }
  // Still waiting on the document byte budget when the run timed out.
  if (document.type === "busy") {
    return Result.err("extraction_failed");
  }
  const passages = runPassages(document.blocks, scope);
  return passages === null || passages.length === 0
    ? Result.err("extraction_failed")
    : Result.ok({ blocks: document.blocks, passages });
};

const executeRun = async ({
  actor,
  admission,
  run,
  accessProof,
  deadline,
  grants,
  execution = {},
}: ExecuteRunArgs): Promise<VerificationRunErrorCode | null> => {
  const file = await resolvePinnedFile(actor, run);
  if (Result.isError(file)) {
    return file.error;
  }
  const current = await resolveRunningActorAccess(actor, grants);
  if (current.status === "unavailable") {
    return "access_revoked";
  }
  const abortSignal = deadline();
  const read = await readRunPassages({
    actor,
    file: file.value,
    scope: run.scope,
    readDocument: execution.readDocument ?? readVerificationDocument,
    signal: abortSignal,
  });
  if (Result.isError(read)) {
    return read.error;
  }
  const { blocks, passages } = read.value;

  const configResult = await Result.tryPromise({
    try: async () => {
      const settings = await actor.writeDb(
        async (tx) => await loadOrgAISettings(tx, actor),
      );
      if (Result.isError(settings)) {
        return Result.err(settings.error);
      }
      const { orgAIConfig, managedAIResidency, promptCachingEnabled } =
        settings.value;
      return Result.ok({
        orgAIConfig,
        managedAIResidency,
        model: getTanStackTextModelInfoForTask(
          VERIFICATION_MODEL_TASK,
          orgAIConfig,
          {
            dataClass: "customer",
            organizationId: actor.organizationId,
            modelTier: admission.modelTier,
          },
        ),
        promptCachingEnabled,
      });
    },
    catch: (cause) => cause,
  });
  const config = Result.flatten(configResult);
  if (Result.isError(config)) {
    observeFailure(config.error, {
      sink: CONFIG_FAILED_SINK,
      ctx: { runId: actor.runId, workspaceId: actor.workspaceId },
    });
    return "ai_unavailable";
  }
  await actor.writeDb(
    async (tx) =>
      // audit: skip — records the model the run used, on a run audited at creation.
      await tx
        .update(legalListVerificationRuns)
        .set({ modelRef: formatModelRef(config.value.model) })
        .where(
          and(
            eq(legalListVerificationRuns.id, actor.runId),
            eq(legalListVerificationRuns.workspaceId, actor.workspaceId),
            eq(legalListVerificationRuns.organizationId, actor.organizationId),
            eq(legalListVerificationRuns.requestedBy, actor.userId),
          ),
        ),
  );

  const deps: VerificationModelDeps = {
    admission,
    accessProof,
    checkRunBudget: async () =>
      await actor.writeDb(
        async (tx) =>
          await checkModelRunCaps({
            tx,
            organizationId: actor.organizationId,
            ...VERIFICATION_DISPATCH_CAPS,
          }),
      ),
    ...(execution.generateObjectForTask === undefined
      ? {}
      : { generateObjectForTask: execution.generateObjectForTask }),
    refreshAccessProof: async () => {
      const decision = await resolveRunningActorAccess(actor, grants);
      if (decision.status === "unavailable") {
        return null;
      }
      return decision.proof;
    },
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    entityVersionId: run.entityVersionId,
    orgAIConfig: config.value.orgAIConfig,
    managedAIResidency: config.value.managedAIResidency,
    promptCachingEnabled: config.value.promptCachingEnabled,
    serviceTier: SERVICE_TIER,
    usageMetering: {
      actionType: "doc_review",
      organizationId: actor.organizationId,
      safeDb: actor.writeSafeDb,
      serviceTier: SERVICE_TIER,
      userId: actor.userId,
      workspaceId: actor.workspaceId,
    },
    abortSignal,
  };

  const extracted = await extractClaims({ passages, deps });
  if (Result.isError(extracted)) {
    if (extracted.error.cause instanceof ModelRunCapError) {
      return "run_limit_reached";
    }
    return extracted.error.cause instanceof ListVerificationAccessRevokedError
      ? "access_revoked"
      : "extraction_failed";
  }
  const claims = extracted.value;
  const graded = await gradeClaims({
    claims: claims.flatMap((claim, position) =>
      claim.type === "fact"
        ? [
            {
              key: String(position),
              text: claim.text,
              context: passageContext(
                passages.at(claim.blockIndex) ??
                  panic("An extracted claim names a block outside the run"),
                claim.anchor,
              ),
              // A new run's claims have no reviewer yet.
              linkedFactIds: [],
            },
          ]
        : [],
    ),
    facts: run.evidence.facts,
    deps,
  });
  if (Result.isError(graded)) {
    if (graded.error.cause instanceof ModelRunCapError) {
      return "run_limit_reached";
    }
    return graded.error.cause instanceof ListVerificationAccessRevokedError
      ? "access_revoked"
      : "grading_failed";
  }
  if (graded.value.type === "incomplete") {
    return "grading_failed";
  }

  const rows = claimRows(actor, claims, graded.value, blocks);
  await actor.writeDb(async (tx) => {
    const access = await resolveListVerificationRunAccess({
      tx,
      run: {
        id: actor.runId,
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
      },
      requesterId: actor.userId,
      expectedStatus: "running",
      grants,
    });
    if (access.status === "unavailable") {
      await failVerificationRun({
        tx,
        run: {
          id: actor.runId,
          workspaceId: actor.workspaceId,
          organizationId: actor.organizationId,
        },
        errorCode: "access_revoked",
        expectedStatus: "running",
      });
      return;
    }
    await completeVerificationRun({
      tx,
      runId: actor.runId,
      workspaceId: actor.workspaceId,
      blocks: passages.map((passage) => passage.block),
      claims: rows,
    });
  });
  return null;
};

type ClaimedVerification = {
  run: ClaimedRun & { evidence: VerificationEvidence };
  proof: ListVerificationAccessProof;
};

/**
 * Settle the persisted requester's access and claim the run in one
 * transaction: a requester who lost access closes the run instead, so a
 * revoked run never reaches the model.
 */
const claimVerificationRun = async ({
  actor,
  context: { grants },
}: {
  actor: RunActor;
  context: VerificationQueueContext;
}): Promise<ClaimedVerification | null> =>
  await actor.writeDb(async (tx) => {
    const run = (
      await tx
        .select({ requestedBy: legalListVerificationRuns.requestedBy })
        .from(legalListVerificationRuns)
        .where(
          and(
            eq(legalListVerificationRuns.id, actor.runId),
            eq(legalListVerificationRuns.workspaceId, actor.workspaceId),
            eq(legalListVerificationRuns.organizationId, actor.organizationId),
          ),
        )
        .limit(1)
        .for("update")
    ).at(0);
    if (
      run === undefined ||
      (run.requestedBy !== null && run.requestedBy !== actor.userId)
    ) {
      return null;
    }
    const decision = await resolveListVerificationAccess({
      tx,
      organizationId: actor.organizationId,
      userId: run.requestedBy,
      workspaceId: actor.workspaceId,
      grants,
    });
    if (decision.status === "unavailable") {
      await failVerificationRun({
        tx,
        run: {
          id: actor.runId,
          workspaceId: actor.workspaceId,
          organizationId: actor.organizationId,
        },
        errorCode: "access_revoked",
      });
      return null;
    }
    const claimed = await claimRun({ tx, actor, accessProof: decision.proof });
    if (claimed === null) {
      return null;
    }
    const evidence = await readRunEvidenceForGrading({
      tx,
      workspaceId: actor.workspaceId,
      runId: actor.runId,
    });
    return {
      run: {
        ...claimed,
        evidence: evidence ?? panic("Claimed verification run is missing"),
      },
      proof: decision.proof,
    };
  });

/** The queue's execution for a run, from the verification's own. */
const queueExecute =
  (
    execute: typeof executeRun,
  ): DocumentRunExecute<
    "legalListVerificationRun",
    ClaimedVerification,
    VerificationRunErrorCode,
    VerificationQueueContext
  > =>
  async ({ actor, admission, run, context, deadline }) =>
    await execute({
      actor,
      admission,
      run: run.run,
      accessProof: run.proof,
      deadline,
      grants: context.grants,
      ...(context.execution === undefined
        ? {}
        : { execution: context.execution }),
    });

const LIST_VERIFICATION_RUN_JOBS = createDocumentRunJobs<
  "legal-list-verification-runs",
  "legalListVerificationRun"
>({
  name: "legal-list-verification-runs",
  jobName: "run-list-verification",
});

export const listVerificationRunQueue = createDocumentRunQueue({
  jobs: LIST_VERIFICATION_RUN_JOBS,
  actionKind: "list-verification.background",
  limits: STANDARD_DOCUMENT_RUN_LIMITS,
  workerContext: WORKER_CONTEXT,
  actor: brandActor,
  claim: claimVerificationRun,
  execute: queueExecute(executeRun),
  fail: async ({ actor, errorCode, context }) =>
    await setRunFailed({ actor, errorCode, grants: context.grants }),
  thrownErrorCode: (error) =>
    error instanceof ListVerificationAccessRevokedError
      ? "access_revoked"
      : "internal",
  readQueuedPage: async (db: ReconcileDb, cursor: QueuedRunRow | null) =>
    await readActiveRunPage(db, cursor, "queued"),
  admitQueued: admitQueuedRun,
  failStuck: failStuckRuns,
});

export const enqueueListVerificationRun = async (
  args: EnqueueDocumentRunArgs<"legalListVerificationRun">,
): Promise<void> => {
  await LIST_VERIFICATION_RUN_JOBS.enqueue(args);
};

export const reconcileStuckListVerificationRuns = async (
  db: ReconcileDb,
  grants?: FeatureAccessGrants,
): Promise<number> =>
  await listVerificationRunQueue.reconcileStuck({ db, context: { grants } });

export const reconcileQueuedListVerificationRuns = async ({
  db,
  queue,
  grants,
}: {
  db: ReconcileDb;
  queue?: RequeueableQueue<DocumentRunJobData>;
  grants?: FeatureAccessGrants | undefined;
}) =>
  await listVerificationRunQueue.reconcileQueued({
    db,
    context: { grants },
    ...(queue === undefined ? {} : { queue }),
  });

type ProcessListVerificationRunArgs = {
  data: DocumentRunJobData;
  admission: ModelDispatchAdmission;
  actor?: RunActor;
  grants?: FeatureAccessGrants | undefined;
  execute?: typeof executeRun;
  execution?: VerificationExecutionBoundaries;
};

export const processListVerificationRun = async ({
  data,
  admission,
  actor = brandActor(data),
  grants,
  execute,
  execution,
}: ProcessListVerificationRunArgs): Promise<void> => {
  await listVerificationRunQueue.processRun({
    actor,
    admission,
    context: {
      grants,
      ...(execution === undefined ? {} : { execution }),
    },
    ...(execute === undefined ? {} : { execute: queueExecute(execute) }),
  });
};

export const initListVerificationRunWorker = () =>
  listVerificationRunQueue.initWorker();
