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

import { panic, Result } from "better-result";
import { Worker } from "bullmq";
import { and, asc, eq, inArray, lt, or } from "drizzle-orm";

import { DAY_IN_MS, Temporal } from "@stll/time";

import { rootDb } from "@/api/db/root";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  fields,
  legalListClaims,
  legalListVerificationRuns,
} from "@/api/db/schema";
import {
  loadOrgAIConfig,
  loadPromptCachingPreference,
} from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import {
  QUEUE_REQUEUE_OUTCOME,
  requeueDeterministicJob,
} from "@/api/lib/bullmq-requeue";
import type { RequeueableQueue } from "@/api/lib/bullmq-requeue";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { errorTag } from "@/api/lib/errors/utils";
import { extractClaims } from "@/api/lib/lists/verification/claim-extract";
import type { ExtractedClaim } from "@/api/lib/lists/verification/claim-extract";
import { gradeClaims } from "@/api/lib/lists/verification/claim-grade";
import type { ClaimGrade } from "@/api/lib/lists/verification/claim-grade";
import { VERIFICATION_RUN_ACTIVE_STATUSES } from "@/api/lib/lists/verification/contract";
import type {
  VerificationEvidence,
  VerificationRunErrorCode,
} from "@/api/lib/lists/verification/contract";
import { readVerificationDocument } from "@/api/lib/lists/verification/document-text";
import { VERIFICATION_MODEL_ROLE } from "@/api/lib/lists/verification/model-call";
import type { VerificationModelDeps } from "@/api/lib/lists/verification/model-call";
import { startNonOverlappingInterval } from "@/api/lib/non-overlapping-interval";
import { logger } from "@/api/lib/observability/logger";
import {
  RECONCILE_SCAN_PAGE_SIZE,
  reconcileCursorTimestamp,
  scanPendingRows,
} from "@/api/lib/queue-reconcile-scan";
import type { ReconcileScanResult } from "@/api/lib/queue-reconcile-scan";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { createRootSafeDb, createRootScopedDb } from "@/api/lib/root-scoped-db";
import {
  brandPersistedListVerificationRunId,
  brandPersistedUserId,
  brandValidatedWorkflowActorKey,
} from "@/api/lib/safe-id-boundaries";
import {
  formatModelRef,
  getTanStackTextModelInfoForRole,
} from "@/api/lib/tanstack-ai-models";

const QUEUE_NAME = "legal-list-verification-runs";
const JOB_NAME = "run-list-verification";
const WORKER_CONCURRENCY = 2;
const JOB_ATTEMPTS = 1;
/** Budget for the whole run; each model call carries its own timeout. Stays
 *  under `STUCK_RUNNING_MS`, which catches a worker that died. */
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const SERVICE_TIER = "standard" as const;
const JANITOR_INTERVAL_MS = 5 * 60 * 1000;
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

/**
 * Fail runs a hard worker death left behind: a `kill -9` emits no `failed`
 * event, and the claim guard makes a stalled re-delivery a no-op, so the row
 * would hold its document's active slot forever. Cross-workspace, hence the
 * root handle.
 */
export const reconcileStuckListVerificationRuns = async (): Promise<number> => {
  const runningCutoff = new Date(
    Temporal.Now.instant().epochMilliseconds - STUCK_RUNNING_MS,
  );
  const queuedCutoff = new Date(
    Temporal.Now.instant().epochMilliseconds - STUCK_QUEUED_MS,
  );
  const recovered = await rootDb
    .update(legalListVerificationRuns)
    .set({ status: "failed", errorCode: "internal", finishedAt: new Date() })
    .where(
      or(
        and(
          eq(legalListVerificationRuns.status, "running"),
          lt(legalListVerificationRuns.startedAt, runningCutoff),
        ),
        and(
          eq(legalListVerificationRuns.status, "queued"),
          lt(legalListVerificationRuns.createdAt, queuedCutoff),
        ),
      ),
    )
    .returning({ id: legalListVerificationRuns.id });
  return recovered.length;
};

const runCursorCodec = createTimestampIdCursorCodec({
  column: legalListVerificationRuns.createdAt,
  brandId: brandPersistedListVerificationRunId,
});

type QueuedRunRow = {
  createdCursor: string;
  id: SafeId<"legalListVerificationRun">;
  organizationId: SafeId<"organization">;
  requestedBy: string | null;
  workspaceId: SafeId<"workspace">;
};

type ReconcileQueuedOptions = {
  db?: Pick<typeof rootDb, "select">;
  queue?: RequeueableQueue<ListVerificationJobData>;
};

type ReconcileQueuedResult = ReconcileScanResult & {
  /** Runs whose requester's account is gone: counted, left to the janitor. */
  unattributed: number;
};

/**
 * Hand `queued` runs back to the queue when nothing owns them. The row
 * commits before the job is added, so a crash in between, or a queue that
 * lost its jobs, leaves a run no worker will pick up. Re-adding is safe: the
 * job id is the run id and only a `queued` row is claimable.
 */
export const reconcileQueuedListVerificationRuns = async ({
  db = rootDb,
  queue = getQueue(),
}: ReconcileQueuedOptions = {}): Promise<ReconcileQueuedResult> => {
  let unattributed = 0;

  const after = (cursor: QueuedRunRow | null) =>
    cursor === null
      ? undefined
      : runCursorCodec.keysetAfter({
          cursor: {
            timestamp: reconcileCursorTimestamp(cursor.createdCursor),
            id: cursor.id,
          },
          idColumn: legalListVerificationRuns.id,
          direction: "ascending",
        });

  const readPage = async (cursor: QueuedRunRow | null) =>
    await db
      .select({
        createdCursor: runCursorCodec.cursorValue,
        id: legalListVerificationRuns.id,
        organizationId: legalListVerificationRuns.organizationId,
        requestedBy: legalListVerificationRuns.requestedBy,
        workspaceId: legalListVerificationRuns.workspaceId,
      })
      .from(legalListVerificationRuns)
      .where(and(eq(legalListVerificationRuns.status, "queued"), after(cursor)))
      .orderBy(
        asc(legalListVerificationRuns.createdAt),
        asc(legalListVerificationRuns.id),
      )
      .limit(RECONCILE_SCAN_PAGE_SIZE);

  const handle = async (run: QueuedRunRow): Promise<boolean> => {
    if (run.requestedBy === null) {
      unattributed += 1;
      return false;
    }
    const { data, name, opts } = runJob({
      organizationId: run.organizationId,
      runId: run.id,
      userId: brandPersistedUserId(run.requestedBy),
      workspaceId: run.workspaceId,
    });
    const outcome = await Result.tryPromise({
      try: async () =>
        await requeueDeterministicJob({ data, jobId: opts.jobId, name, queue }),
      catch: (cause) => cause,
    });
    if (Result.isError(outcome)) {
      captureError(outcome.error, { runId: run.id });
      return false;
    }
    return outcome.value === QUEUE_REQUEUE_OUTCOME.REQUEUED;
  };

  const scan = await scanPendingRows({ handle, readPage });
  return { ...scan, unattributed };
};

type RunActor = {
  scopedDb: ScopedDb;
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  runId: SafeId<"legalListVerificationRun">;
};

const brandActor = (data: ListVerificationJobData): RunActor => {
  const branded = brandValidatedWorkflowActorKey({
    organizationId: data.organizationId,
    workspaceId: data.workspaceId,
  });
  const userId = brandPersistedUserId(data.userId);
  const tenant = {
    organizationId: branded.organizationId,
    userId,
    workspaceIds: [branded.workspaceId],
  };
  return {
    organizationId: branded.organizationId,
    workspaceId: branded.workspaceId,
    userId,
    runId: brandPersistedListVerificationRunId(data.runId),
    scopedDb: createRootScopedDb(tenant),
    safeDb: createRootSafeDb(tenant),
  };
};

type ClaimedRun = {
  fileFieldId: SafeId<"field">;
  entityVersionId: SafeId<"entityVersion">;
  contentSha256: string;
  evidence: VerificationEvidence;
};

/** Conditional `queued -> running`: the loser of a double delivery updates
 *  nothing and stops. */
const claimRun = async (actor: RunActor): Promise<ClaimedRun | null> => {
  const rows = await actor.scopedDb(
    async (tx) =>
      // audit: skip — lifecycle bookkeeping on a run audited at creation.
      await tx
        .update(legalListVerificationRuns)
        .set({ status: "running", startedAt: new Date() })
        .where(
          and(
            eq(legalListVerificationRuns.id, actor.runId),
            eq(legalListVerificationRuns.workspaceId, actor.workspaceId),
            eq(legalListVerificationRuns.status, "queued"),
          ),
        )
        .returning({
          fileFieldId: legalListVerificationRuns.fileFieldId,
          entityVersionId: legalListVerificationRuns.entityVersionId,
          contentSha256: legalListVerificationRuns.contentSha256,
          evidence: legalListVerificationRuns.evidence,
        }),
  );
  return rows.at(0) ?? null;
};

const setRunFailed = async (
  actor: RunActor,
  errorCode: VerificationRunErrorCode,
): Promise<void> => {
  await actor.scopedDb(async (tx) => {
    // audit: skip — failure bookkeeping on a run audited at creation.
    await tx
      .update(legalListVerificationRuns)
      .set({ status: "failed", errorCode, finishedAt: new Date() })
      .where(
        and(
          eq(legalListVerificationRuns.id, actor.runId),
          eq(legalListVerificationRuns.workspaceId, actor.workspaceId),
          inArray(legalListVerificationRuns.status, [
            ...VERIFICATION_RUN_ACTIVE_STATUSES,
          ]),
        ),
      );
  });
};

type ResolvedFile = {
  fileId: string;
  mimeType: string;
  pdfFileId: string | null;
};

/** The pinned file, or why it can no longer be read as pinned. */
const resolvePinnedFile = async (
  actor: RunActor,
  run: ClaimedRun,
): Promise<Result<ResolvedFile, VerificationRunErrorCode>> => {
  const row = (
    await actor.scopedDb(
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
      state: grade.state,
      score: grade.score,
      refs: grade.refs,
      recordConflict: grade.recordConflict,
    };
  });

/** Null on success, else the code the run failed with. */
const executeRun = async (
  actor: RunActor,
  run: ClaimedRun,
): Promise<VerificationRunErrorCode | null> => {
  const file = await resolvePinnedFile(actor, run);
  if (Result.isError(file)) {
    return file.error;
  }
  const document = await readVerificationDocument({
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    file: file.value,
  });
  if (document.type === "unsupported-format") {
    return "unsupported_format";
  }
  if (document.type === "no-text") {
    return "no_text";
  }

  const config = await Result.tryPromise({
    try: async () => {
      const orgAIConfig = await loadOrgAIConfig(actor.organizationId);
      return {
        orgAIConfig,
        model: getTanStackTextModelInfoForRole(
          VERIFICATION_MODEL_ROLE,
          orgAIConfig,
          { organizationId: actor.organizationId },
        ),
        promptCachingEnabled: await loadPromptCachingPreference(
          actor.organizationId,
        ),
      };
    },
    catch: (cause) => cause,
  });
  if (Result.isError(config)) {
    captureError(config.error, {
      runId: actor.runId,
      workspaceId: actor.workspaceId,
    });
    return "ai_unavailable";
  }
  await actor.scopedDb(
    async (tx) =>
      // audit: skip — records the model the run used, on a run audited at creation.
      await tx
        .update(legalListVerificationRuns)
        .set({ modelRef: formatModelRef(config.value.model) })
        .where(
          and(
            eq(legalListVerificationRuns.id, actor.runId),
            eq(legalListVerificationRuns.workspaceId, actor.workspaceId),
          ),
        ),
  );

  const deps: VerificationModelDeps = {
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    entityVersionId: run.entityVersionId,
    orgAIConfig: config.value.orgAIConfig,
    promptCachingEnabled: config.value.promptCachingEnabled,
    serviceTier: SERVICE_TIER,
    usageMetering: {
      actionType: "doc_review",
      organizationId: actor.organizationId,
      safeDb: actor.safeDb,
      serviceTier: SERVICE_TIER,
      userId: actor.userId,
      workspaceId: actor.workspaceId,
    },
    abortSignal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  };

  const extracted = await extractClaims({ blocks: document.blocks, deps });
  if (Result.isError(extracted)) {
    return "extraction_failed";
  }
  const claims = extracted.value;
  const graded = await gradeClaims({
    claims: claims.flatMap((claim, position) =>
      claim.type === "fact"
        ? [{ key: String(position), text: claim.text }]
        : [],
    ),
    facts: run.evidence.facts,
    blocks: document.blocks,
    deps,
  });
  if (Result.isError(graded) || graded.value.type === "incomplete") {
    return "grading_failed";
  }

  const rows = claimRows(actor, claims, graded.value.grades);
  await actor.scopedDb(async (tx) => {
    // Complete first, guarded on `running`: a run the janitor already failed
    // must not gain claims afterwards.
    // audit: skip — lifecycle bookkeeping on a run audited at creation.
    const completed = await tx
      .update(legalListVerificationRuns)
      .set({ status: "completed", finishedAt: new Date() })
      .where(
        and(
          eq(legalListVerificationRuns.id, actor.runId),
          eq(legalListVerificationRuns.workspaceId, actor.workspaceId),
          eq(legalListVerificationRuns.status, "running"),
        ),
      )
      .returning({ id: legalListVerificationRuns.id });
    if (completed.length === 0 || rows.length === 0) {
      return;
    }
    // audit: skip — engine output of a run audited at creation.
    await tx
      .insert(legalListClaims)
      .values(rows)
      .onConflictDoNothing({
        target: [legalListClaims.runId, legalListClaims.position],
      });
  });
  return null;
};

const processJob = async (data: ListVerificationJobData): Promise<void> => {
  const actor = brandActor(data);
  const claimed = await claimRun(actor);
  if (claimed === null) {
    return;
  }
  const outcome = await Result.tryPromise({
    try: async () => await executeRun(actor, claimed),
    catch: (cause) => cause,
  });
  if (Result.isError(outcome)) {
    captureError(outcome.error, {
      runId: actor.runId,
      workspaceId: actor.workspaceId,
    });
    await setRunFailed(actor, "internal");
    return;
  }
  if (outcome.value !== null) {
    await setRunFailed(actor, outcome.value);
  }
};

export const initListVerificationRunWorker = () => {
  const worker = new Worker<ListVerificationJobData>(
    QUEUE_NAME,
    async (job) => {
      await processJob(job.data);
    },
    { connection: createBullMqConnection(), concurrency: WORKER_CONCURRENCY },
  );

  worker.on("failed", (job, error) => {
    if (job) {
      setRunFailed(brandActor(job.data), "internal").catch(
        (markError: unknown) => {
          captureError(markError, {
            runId: job.data.runId,
            workspaceId: job.data.workspaceId,
          });
        },
      );
    }
    const runId = job ? job.data.runId : "";
    const workspaceId = job ? job.data.workspaceId : "";
    captureError(error, { runId, workspaceId });
    logger.error("list_verification_run.failed", {
      runId,
      "error.type": errorTag(error),
      queue: QUEUE_NAME,
      workspaceId,
    });
  });

  worker.on(
    "error",
    createQueueWorkerErrorLogger("list_verification_run.worker_error", {
      queue: QUEUE_NAME,
    }),
  );

  const closeJanitor = startNonOverlappingInterval({
    intervalMs: JANITOR_INTERVAL_MS,
    run: async () => {
      const recovered = await reconcileStuckListVerificationRuns();
      if (recovered > 0) {
        logger.warn("list_verification_run.recovered_stuck", {
          count: String(recovered),
        });
      }
    },
    onError: (error) => {
      captureError(error, { operation: "list_verification_run.reconcile" });
    },
  });

  logger.info("list_verification_run.worker_started", {
    concurrency: String(WORKER_CONCURRENCY),
  });

  return {
    queues: [QUEUE_NAME] as const,
    close: async () => {
      await closeJanitor();
      await worker.close();
    },
  };
};
