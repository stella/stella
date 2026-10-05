/**
 * Background queue for list verifications: the same one-shot shape as the
 * document-review queue.
 *
 * `attempts: 1`: every run spends metered model calls, so a retry would pay
 * twice. Any failure lands `status: "failed"` with a closed error code, and a
 * person retries by starting a new run.
 *
 * Convergence: the job id is the run id, only a `queued` row is claimable,
 * and claims are written on `(runId, position)` in one statement that ignores
 * rows already there. A re-delivered job is a no-op or rewrites nothing.
 */

import { panic, Result, TaggedError } from "better-result";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";

import { DAY_IN_MS, Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { legalListClaims } from "@/api/db/schema";
import { fields, legalListVerificationRuns } from "@/api/db/schema";
import { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { BullMqWorker, createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import {
  requeueDeterministicJob,
  QUEUE_REQUEUE_OUTCOME,
} from "@/api/lib/bullmq-requeue";
import type { RequeueableQueue } from "@/api/lib/bullmq-requeue";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import type { ListVerificationAccessProof } from "@/api/lib/lists/verification/access";
import { resolveListVerificationAccess } from "@/api/lib/lists/verification/access-context";
import { extractClaims } from "@/api/lib/lists/verification/claim-extract";
import type { ExtractedClaim } from "@/api/lib/lists/verification/claim-extract";
import {
  gradeClaims,
  gradedClaimType,
} from "@/api/lib/lists/verification/claim-grade";
import type { ClaimGrade } from "@/api/lib/lists/verification/claim-grade";
import {
  VERIFICATION_LIMITS,
  VERIFICATION_RUN_ACTIVE_STATUSES,
} from "@/api/lib/lists/verification/contract";
import type {
  VerificationEvidence,
  VerificationRunErrorCode,
} from "@/api/lib/lists/verification/contract";
import { readVerificationDocument } from "@/api/lib/lists/verification/document-text";
import {
  ListVerificationAccessRevokedError,
  VERIFICATION_MODEL_ROLE,
} from "@/api/lib/lists/verification/model-call";
import type { VerificationModelDeps } from "@/api/lib/lists/verification/model-call";
import {
  completeVerificationRun,
  failVerificationRun,
} from "@/api/lib/lists/verification/run-persistence";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  RECONCILE_SCAN_PAGE_SIZE,
  reconcileCursorTimestamp,
  scanPendingRows,
} from "@/api/lib/queue-reconcile-scan";
import type { ReconcileScanResult } from "@/api/lib/queue-reconcile-scan";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { runBackgroundJob } from "@/api/lib/rate-limit/queued-action-admission";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import type { RootRunActor } from "@/api/lib/root-scoped-db";
import {
  brandPersistedUserId,
  brandPersistedListVerificationRunId,
} from "@/api/lib/safe-id-boundaries";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import {
  formatModelRef,
  getTanStackTextModelInfoForRole,
} from "@/api/lib/tanstack-ai-models";

const QUEUE_NAME = "legal-list-verification-runs";

const CONFIG_FAILED_SINK = failureSink({
  event: "list_verification_run.config_failed",
  expected: [],
});
const RUN_FAILED_SINK = failureSink({
  event: "list_verification_run.failed",
  expected: [],
});
const MARK_FAILED_SINK = failureSink({
  event: "list_verification_run.mark_failed_failed",
  expected: [],
});
const JOB_NAME = "run-list-verification";
const WORKER_CONCURRENCY = 2;
const JOB_ATTEMPTS = 1;
/** Budget for the whole run; each model call carries its own timeout. Stays
 *  under `STUCK_RUNNING_MS`, which catches a worker that died. */
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const SERVICE_TIER = "standard" as const;
const STUCK_RUNNING_MS = 30 * 60 * 1000;
/** Younger `queued` rows may simply be backlogged. */
const STUCK_QUEUED_MS = DAY_IN_MS;

type ListVerificationJobData = {
  runId: string;
  workspaceId: string;
  organizationId: string;
  userId: string;
};

export type EnqueueListVerificationRunArgs = {
  runId: SafeId<"legalListVerificationRun">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

const getQueue = createLazyBullMqQueue<ListVerificationJobData>({
  name: QUEUE_NAME,
  defaultJobOptions: {
    attempts: JOB_ATTEMPTS,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

/** The run id is the job identity, so a duplicate enqueue collapses. */
const runJob = ({
  runId,
  workspaceId,
  organizationId,
  userId,
}: EnqueueListVerificationRunArgs) => ({
  name: JOB_NAME,
  data: {
    runId,
    workspaceId,
    organizationId,
    userId,
  } satisfies ListVerificationJobData,
  opts: { jobId: createBullMqJobId(workspaceId, runId) },
});

export const enqueueListVerificationRun = async (
  args: EnqueueListVerificationRunArgs,
): Promise<void> => {
  const { name, data, opts } = runJob(args);
  await getQueue().add(name, data, opts);
};

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

/**
 * Fail runs a hard worker death left behind: a `kill -9` emits no `failed`
 * event, and the claim guard makes a stalled re-delivery a no-op, so the row
 * would hold its document's active slot forever. Cross-workspace, so it runs
 * on the scheduler's handle.
 */
export const reconcileStuckListVerificationRuns = async (
  db: Pick<SchedulerDb, "select" | "transaction">,
  grants?: FeatureAccessGrants,
): Promise<number> => {
  let recovered = 0;
  await scanPendingRows({
    readPage: async (cursor: QueuedRunRow | null) =>
      await readActiveRunPage(db, cursor),
    handle: async (run) => {
      const runningCutoff =
        Temporal.Now.instant().epochMilliseconds - STUCK_RUNNING_MS;
      const queuedCutoff =
        Temporal.Now.instant().epochMilliseconds - STUCK_QUEUED_MS;
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

export class ListVerificationReconcileError extends TaggedError(
  "ListVerificationReconcileError",
)<{
  message: string;
  cause: unknown;
}> {}

type ReconcileQueuedRunsResult = ReconcileScanResult & {
  /** Runs whose requester is gone and whose active slot was closed. */
  unattributed: number;
};

type ReconcileQueuedOptions = {
  db: Pick<SchedulerDb, "select" | "transaction">;
  queue?: RequeueableQueue<ListVerificationJobData>;
  grants?: FeatureAccessGrants | undefined;
};

/**
 * Hand `queued` runs back to the queue when nothing owns them. The row
 * commits before the job is added, so a crash in between, or a queue that
 * lost its jobs, leaves a run no worker will pick up. Re-adding is safe: the
 * job id is the run id and only a `queued` row is claimable.
 */
export const reconcileQueuedListVerificationRuns = async ({
  db,
  queue = getQueue(),
  grants,
}: ReconcileQueuedOptions): Promise<
  Result<ReconcileQueuedRunsResult, ListVerificationReconcileError>
> => {
  let unattributed = 0;
  const scan = await Result.tryPromise({
    try: async () =>
      await scanPendingRows({
        readPage: async (cursor: QueuedRunRow | null) =>
          await readActiveRunPage(db, cursor, "queued"),
        handle: async (run) => {
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
          if (access.status === "unavailable" || run.requestedBy === null) {
            if (run.requestedBy === null) {
              unattributed += 1;
            }
            return false;
          }
          const { name, data, opts } = runJob({
            runId: run.id,
            workspaceId: run.workspaceId,
            organizationId: run.organizationId,
            userId: brandPersistedUserId(run.requestedBy),
          });
          const outcome = await requeueDeterministicJob({
            data,
            name,
            jobId: opts.jobId,
            queue,
          });
          return outcome === QUEUE_REQUEUE_OUTCOME.REQUEUED;
        },
      }),
    catch: (cause) => {
      observeFailure(cause, {
        sink: RUN_FAILED_SINK,
        ctx: { queue: QUEUE_NAME },
      });
      return new ListVerificationReconcileError({
        message: "List verification reconciliation failed",
        cause,
      });
    },
  });
  if (Result.isError(scan)) {
    return scan;
  }
  return Result.ok({ ...scan.value, unattributed });
};

type RunActor = RootRunActor<"legalListVerificationRun">;

const brandActor = (data: ListVerificationJobData): RunActor =>
  createRootRunActor(data, brandPersistedListVerificationRunId);

type ClaimedRun = {
  fileFieldId: SafeId<"field">;
  entityVersionId: SafeId<"entityVersion">;
  contentSha256: string;
  evidence: VerificationEvidence;
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
      evidence: legalListVerificationRuns.evidence,
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
  });
};

type ClaimRow = typeof legalListClaims.$inferInsert;

/** One row per claim in reading order; a set-aside claim is never graded. */
const claimRows = (
  actor: RunActor,
  claims: readonly ExtractedClaim[],
  grades: ReadonlyMap<string, ClaimGrade>,
): ClaimRow[] =>
  claims.map((claim, position): ClaimRow => {
    const base = {
      id: createSafeId<"legalListClaim">(),
      workspaceId: actor.workspaceId,
      runId: actor.runId,
      position,
      type: claim.type,
      framing: claim.framing,
      text: claim.text,
      anchor: claim.anchor,
    };
    if (claim.type !== "fact") {
      return {
        ...base,
        state: "notverifiable",
        score: null,
        refs: [],
        recordConflict: null,
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
    };
  });

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

/** Trusted process-local I/O boundaries; never sourced from queued data. */
type VerificationExecutionBoundaries = {
  readDocument?: typeof readVerificationDocument;
  generateObjectForRole?: VerificationModelDeps["generateObjectForRole"];
};

/** Null on success, else the code the run failed with. */
type ExecuteRunArgs = {
  actor: RunActor;
  admission: ModelDispatchAdmission;
  run: ClaimedRun;
  accessProof: ListVerificationAccessProof;
  grants?: FeatureAccessGrants | undefined;
  execution?: VerificationExecutionBoundaries;
};

const executeRun = async ({
  actor,
  admission,
  run,
  accessProof,
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
  const abortSignal = AbortSignal.timeout(RUN_TIMEOUT_MS);
  const readDocument = execution.readDocument ?? readVerificationDocument;
  const document = await readDocument({
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    file: file.value,
    signal: abortSignal,
  });
  if (document.type === "unsupported-format") {
    return "unsupported_format";
  }
  if (document.type === "no-text") {
    return "no_text";
  }
  if (document.blocks.length > VERIFICATION_LIMITS.BLOCKS_PER_RUN_MAX) {
    return "extraction_failed";
  }

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
        model: getTanStackTextModelInfoForRole(
          VERIFICATION_MODEL_ROLE,
          orgAIConfig,
          { dataClass: "customer", organizationId: actor.organizationId },
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
    ...(execution.generateObjectForRole === undefined
      ? {}
      : { generateObjectForRole: execution.generateObjectForRole }),
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

  const extracted = await extractClaims({ blocks: document.blocks, deps });
  if (Result.isError(extracted)) {
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
              context: {
                text:
                  document.blocks.at(claim.blockIndex)?.text ??
                  panic(
                    "An extracted claim names a block outside the document",
                  ),
                anchor: claim.anchor,
              },
            },
          ]
        : [],
    ),
    facts: run.evidence.facts,
    deps,
  });
  if (Result.isError(graded)) {
    return graded.error.cause instanceof ListVerificationAccessRevokedError
      ? "access_revoked"
      : "grading_failed";
  }
  if (graded.value.type === "incomplete") {
    return "grading_failed";
  }

  const rows = claimRows(actor, claims, graded.value.grades);
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
      blocks: document.blocks,
      claims: rows,
    });
  });
  return null;
};

type ProcessListVerificationRunArgs = {
  data: ListVerificationJobData;
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
  execute = executeRun,
  execution,
}: ProcessListVerificationRunArgs): Promise<void> => {
  const claim = await actor.writeDb(async (tx) => {
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
    return claimed === null ? null : { run: claimed, proof: decision.proof };
  });
  if (claim === null) {
    return;
  }
  const outcome = await Result.tryPromise({
    try: async () =>
      await execute({
        actor,
        admission,
        run: claim.run,
        accessProof: claim.proof,
        grants,
        ...(execution === undefined ? {} : { execution }),
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(outcome)) {
    observeFailure(outcome.error, {
      sink: RUN_FAILED_SINK,
      ctx: { runId: actor.runId, workspaceId: actor.workspaceId },
    });
    await setRunFailed({
      actor,
      errorCode:
        outcome.error instanceof ListVerificationAccessRevokedError
          ? "access_revoked"
          : "internal",
      grants,
    });
    return;
  }
  if (outcome.value !== null) {
    await setRunFailed({ actor, errorCode: outcome.value, grants });
  }
};

export const initListVerificationRunWorker = () => {
  const worker = new BullMqWorker<ListVerificationJobData>(
    QUEUE_NAME,
    async (job) => {
      const actor = brandActor(job.data);
      // The run's period action was drawn when it was queued; the job takes
      // a background slot. The run bounds its own time.
      await runBackgroundJob({
        actionKind: "list-verification.background",
        organizationId: actor.organizationId,
        userId: actor.userId,
        job,
        signal: new AbortController().signal,
        run: async (_signal, admission) =>
          await processListVerificationRun({ data: job.data, actor, admission }),
      });
    },
    {
      connection: createBullMqConnection({
        storeClass: "durable-coordination",
      }),
      concurrency: WORKER_CONCURRENCY,
    },
  );

  worker.on("failed", (job, error) => {
    if (job) {
      setRunFailed({
        actor: brandActor(job.data),
        errorCode: "internal",
      }).catch((markError: unknown) => {
        observeFailure(markError, {
          sink: MARK_FAILED_SINK,
          ctx: { runId: job.data.runId, workspaceId: job.data.workspaceId },
        });
      });
    }
    observeFailure(error, {
      sink: RUN_FAILED_SINK,
      ctx: {
        queue: QUEUE_NAME,
        ...(job
          ? { runId: job.data.runId, workspaceId: job.data.workspaceId }
          : {}),
      },
    });
  });

  worker.on(
    "error",
    createQueueWorkerErrorLogger("list_verification_run.worker_error", {
      queue: QUEUE_NAME,
    }),
  );

  logger.info("list_verification_run.worker_started", {
    concurrency: String(WORKER_CONCURRENCY),
  });

  return {
    queues: [QUEUE_NAME] as const,
    close: async () => {
      await worker.close();
    },
  };
};
