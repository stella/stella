import { panic, Result } from "better-result";
import { Queue } from "bullmq";
import type { Job } from "bullmq";
import { sleep } from "bun";
import { and, eq, inArray, sql } from "drizzle-orm";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { drainFanOut } from "@stll/concurrency";
import { chunk as chunkItems } from "@stll/concurrency/chunk";
import { Temporal } from "@stll/time";

import { jsonField } from "@/api/db/json-utils";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  cellMetadata,
  type ExtractionRunScope,
  fields,
  justifications,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import type { AIRequestServiceTier } from "@/api/lib/ai-config";
import { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { BullMqWorker } from "@/api/lib/bullmq-queue";
import type { BullMqWorkerContext } from "@/api/lib/bullmq-queue";
import { acquireCellLocks } from "@/api/lib/cell-lock";
import { recordTableRunVerdicts } from "@/api/lib/document-review/table-run-findings";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import {
  connectionErrorFields,
  errorSystemFields,
  errorTag,
} from "@/api/lib/errors/utils";
import { createExtractionRunStore } from "@/api/lib/extraction-runs/store";
import type {
  ExtractionRunStartStore,
  ExtractionRunStore,
} from "@/api/lib/extraction-runs/store";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import { markPropertiesFresh } from "@/api/lib/properties/property-status";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import {
  BACKGROUND_ACTION_KIND,
  QUEUED_ACTION_KIND,
} from "@/api/lib/rate-limit/action-kinds";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import {
  runBackgroundJob,
  runQueuedKickoff,
} from "@/api/lib/rate-limit/queued-action-admission";
import {
  createBullMqConnection,
  isRecoverableRedisPollError,
  isTransientRedisConnectionError,
} from "@/api/lib/redis-client";
import { broadcastWorkspaceResourceSetUpdated } from "@/api/lib/resource-realtime";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import type { RootRunActor } from "@/api/lib/root-scoped-db";
import {
  brandPersistedExtractionRunId,
  brandPersistedEntityId,
  brandPersistedPropertyId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { broadcast } from "@/api/lib/sse";
import {
  collectFullWorkflowTargetIds,
  fetchExplicitWorkflowTargetRows,
  readFullWorkflowSnapshotCursor,
} from "@/api/lib/workflow-target-queries";
import { resolveWorkflowTargetEntityIds } from "@/api/lib/workflow-targets";
import { getBatchGenerator } from "@/api/lib/workflow/generate-batch-provider";
import type {
  AIJustification,
  AIResult,
} from "@/api/lib/workflow/generate-batch-shared";
import type {
  AIBatchProperty,
  BatchProperty,
  ExecutionLevel,
  PropertyBatch,
  VerdictBatchProperty,
} from "@/api/lib/workflow/get-execution-plan";
import {
  getExecutionPlanData,
  getPropertyExecutionPlan,
} from "@/api/lib/workflow/get-execution-plan";
import { resolveDocTypeClassifier } from "@/api/lib/workflow/materialize-playbook-run";
import {
  errorPendingCells,
  selectWorkspacesWithPendingCells,
} from "@/api/lib/workflow/orphan-cells";
import type { OrphanCellsDatabase } from "@/api/lib/workflow/orphan-cells";
import {
  selectExpiredStaleRunWorkspaceIds,
  selectOrphanWorkspaceIds,
  selectRecoverableOrphanWorkspaceIds,
} from "@/api/lib/workflow/orphan-recovery";
import {
  combineLiveWorkflowJobSnapshots,
  workflowQueueClassForServiceTier,
  WORKFLOW_QUEUE_CLASSES,
  WORKFLOW_QUEUE_NAMES,
  WORKFLOW_WORKER_SPECS,
  type WorkflowQueueClass,
  type WorkflowWorkerSpec,
} from "@/api/lib/workflow/queue-topology";
import { getRootWorkflowRunStateStore } from "@/api/lib/workflow/root-run-state-store";
import {
  classifierParticipatedInPlan,
  routeClassifiedDocuments,
} from "@/api/lib/workflow/route-playbooks";
import {
  computeWorkflowJobTimeoutMs,
  computeWorkflowRunLockTtlSec,
  getWorkflowBatchAITimeoutMs,
  runWorkflowBatchGenerationWithRetry,
  WORKFLOW_ENTITY_JOB_ATTEMPTS,
  WORKFLOW_ENTITY_JOB_BACKOFF_DELAY_MS,
} from "@/api/lib/workflow/run-logic";
import { requireWorkflowFinalizationManifest } from "@/api/lib/workflow/run-state-store";
import { startStragglerCatchUp } from "@/api/lib/workflow/straggler-catchup";
import type { PartialAnswerUpdate } from "@/api/lib/workflow/streaming-answer";
import { prepareBatch } from "@/api/lib/workflow/utils";
import { computeVerdictBatch } from "@/api/lib/workflow/verdict-engine";

const EXTRACTION_PREVIEW_EVENT_TYPE = "workflow-extraction-preview";
const EXTRACTION_PREVIEW_THROTTLE_MS = 500;

type ExtractionPreviewPayload = {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  propertyId: SafeId<"property">;
  answer: string | null;
  status: "streaming" | "clear";
};

// ── Entity processing ──────────────────────────────────

type EntityJobData = {
  workspaceId: string;
  organizationId: string;
  userId: string;
  entityId: string;
  executionPlan: ExecutionLevel[];
  requestId: string;
  runLockTtlSec?: number;
  serviceTier?: AIRequestServiceTier;
  /**
   * Property IDs the caller wants processed even if their current
   * content would normally cause `prepareBatch` to skip them (e.g. a
   * `fresh` cell with a real value). Used by single-cell retry so a
   * user can re-run an extraction over an already-populated cell.
   */
  forcePropertyIds?: string[];
};

/**
 * The member a workflow run acts for. Its fields, documents and cell state are
 * read through `inputDb`, under the requester's membership when the job runs;
 * its cells, run state and successor bookkeeping are written through `writeDb`.
 */
type WorkflowRunActor = RootRunActor<"extractionRun">;

const workflowRunActor = (data: EntityJobData): WorkflowRunActor =>
  createRootRunActor(
    {
      organizationId: data.organizationId,
      workspaceId: data.workspaceId,
      userId: data.userId,
      runId: data.requestId,
    },
    brandPersistedExtractionRunId,
  );

/** Recorded on a run whose requester can no longer open its matter. */
const INPUTS_UNAVAILABLE_ERROR_CODE = "ExtractionRunInputsUnavailable";

/**
 * Whether the requester can still open the run's matter. The workspace row is
 * read through `inputDb`, so a requester who lost the matter or left the
 * organization reads nothing.
 */
const requesterCanOpenMatter = async (
  actor: WorkflowRunActor,
): Promise<boolean> =>
  (await actor.inputDb(
    async (tx) =>
      await tx.query.workspaces.findFirst({
        where: { id: { eq: actor.workspaceId } },
        columns: { id: true },
      }),
  )) !== undefined;

const WORKFLOW_ENTITY_JOB_NAME = "process-entity" as const;
type WorkflowEntityJobName = typeof WORKFLOW_ENTITY_JOB_NAME;
type WorkflowEntityQueue = Queue<EntityJobData, void, WorkflowEntityJobName>;
type WorkflowEntityWorker = BullMqWorker<
  EntityJobData,
  void,
  WorkflowEntityJobName
>;
type WorkflowEntityJob = Job<EntityJobData, void, WorkflowEntityJobName>;

// ── Public API ─────────────────────────────────────────

const queues = new Map<WorkflowQueueClass, WorkflowEntityQueue>();
let queueConnection: ReturnType<typeof createBullMqConnection> | null = null;

const getQueueConnection = () => {
  queueConnection ??= createBullMqConnection({
    storeClass: "durable-coordination",
  });
  return queueConnection;
};

const getQueueForClass = (
  queueClass: WorkflowQueueClass,
): WorkflowEntityQueue => {
  const existing = queues.get(queueClass);
  if (existing) {
    return existing;
  }

  const queue = new Queue<EntityJobData, void, WorkflowEntityJobName>(
    WORKFLOW_QUEUE_NAMES[queueClass],
    {
      connection: getQueueConnection(),
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 500,
        // Retry once with backoff so a single transient failure (network
        // blip, AI provider 5xx) doesn't leave the cell empty. Stays low
        // enough that genuine logic errors surface quickly.
        attempts: WORKFLOW_ENTITY_JOB_ATTEMPTS,
        backoff: {
          type: "exponential",
          delay: WORKFLOW_ENTITY_JOB_BACKOFF_DELAY_MS,
        },
      },
    },
  );
  queues.set(queueClass, queue);
  return queue;
};

const getAllWorkflowQueues = (): WorkflowEntityQueue[] =>
  WORKFLOW_QUEUE_CLASSES.map(getQueueForClass);

const isCurrentWorkflowRequest = async ({
  requestId,
  workspaceId,
}: {
  requestId: string;
  workspaceId: SafeId<"workspace">;
}): Promise<boolean> =>
  await getRootWorkflowRunStateStore().isCurrentRequest({
    requestId,
    workspaceId,
  });

// Self-heal levers. Tuned conservatively so the happy path is never
// disrupted, but a stuck job/worker can't block the workspace.
//
// LOCK_DURATION_MS: how long a worker holds a job's lock before BullMQ
// considers it stalled (worker auto-extends every half this window).
// AI extraction can take a few minutes per entity; 5 minutes covers
// the slowest legitimate case with headroom.
//
// STALLED_INTERVAL_MS: how often BullMQ scans for stalled jobs.
//
// MAX_STALLED_COUNT: a job that stalls this many times moves to
// failed (and then retries via `attempts`).
//
// computeWorkflowJobTimeoutMs: process-level ceiling per entity job, scaled
// with the execution plan's depth. A flat 6-minute cap would
// deterministically abort entities with several slow dependency
// levels even when each batch stays within its own AI timeout.
const LOCK_DURATION_MS = 5 * 60 * 1000;
const STALLED_INTERVAL_MS = 30 * 1000;
const MAX_STALLED_COUNT = 2;

// Workflow-level Redis lock TTL. Long enough to outlast a single batch
// even on big workspaces, short enough to self-heal an uncleanly-killed
// worker without stranding the workspace for hours. The lock is also
// extended on each entity completion below, so a long-running workflow
// keeps the TTL fresh regardless of this initial value.
const RUNNING_LOCK_TTL_SEC = 60 * 60;
const RECOVERY_LOCK_VALUE = "recovery";

/**
 * Check if a workflow is currently running for a workspace.
 */
export const isWorkflowRunning = async (
  workspaceId: SafeId<"workspace">,
): Promise<boolean> =>
  await getRootWorkflowRunStateStore().isRunning(workspaceId);

type StartWorkflowArgs = {
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  scopedDb: ScopedDb;
  entityIds?: SafeId<"entity">[];
  entityIdsOrder?: SafeId<"entity">[];
  /**
   * Restrict the execution plan to these property IDs only. Used by
   * single-cell retry to re-run one property for one entity without
   * touching the rest of the entity's cells. Properties outside the
   * filter are dropped from every level of the plan.
   */
  propertyIds?: SafeId<"property">[];
  serviceTier?: AIRequestServiceTier;
  runStateStore?: ReturnType<typeof getRootWorkflowRunStateStore> | undefined;
  /**
   * Where the run's lifecycle row is written. A request passes the request
   * door's store; a worker passes the store its host built, so a run it
   * starts is recorded on the connection the worker was handed.
   */
  extractionRunStore: ExtractionRunStartStore;
  kickoff?: typeof runQueuedKickoff;
  queue?: WorkflowEntityQueue;
};

/**
 * Every way a start attempt ends. Exported as a list so a caller can classify
 * the whole set exhaustively instead of testing one status and treating the
 * rest as success: `failed` in particular is an enqueue failure reported in
 * band, not an exception, and reads as success to anyone who ignores it.
 */
export const WORKFLOW_START_STATUSES = [
  "started",
  "already-running",
  "skipped",
  "failed",
] as const;

export type WorkflowStartStatus = (typeof WORKFLOW_START_STATUSES)[number];

type StartWorkflowResult = {
  status: WorkflowStartStatus;
};

const extractionRunScope = ({
  entityIds,
  propertyIds,
}: {
  entityIds: StartWorkflowArgs["entityIds"] | undefined;
  propertyIds: StartWorkflowArgs["propertyIds"] | undefined;
}): ExtractionRunScope => {
  const hasEntities = entityIds !== undefined && entityIds.length > 0;
  const hasProperties = propertyIds !== undefined && propertyIds.length > 0;
  if (hasEntities && hasProperties) {
    return "cells";
  }
  if (hasProperties) {
    return "properties";
  }
  if (hasEntities) {
    return "entities";
  }
  return "workspace";
};

type EnqueueEntityJobsArgs = {
  entityIds: readonly SafeId<"entity">[];
  executionPlan: ExecutionLevel[];
  jobIds: readonly string[];
  organizationId: SafeId<"organization">;
  q: WorkflowEntityQueue;
  requestId: string;
  runLockTtlSec: number;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  serviceTier: AIRequestServiceTier;
  forcePropertyIds?: readonly SafeId<"property">[];
};

const workflowEntityJobId = ({
  entityId,
  requestId,
}: {
  entityId: SafeId<"entity">;
  requestId: string;
}): string => `workflow-${requestId}-${entityId}`;

const enqueueEntityJobs = async ({
  entityIds,
  executionPlan,
  jobIds,
  organizationId,
  q,
  requestId,
  runLockTtlSec,
  serviceTier,
  userId,
  workspaceId,
  forcePropertyIds,
}: EnqueueEntityJobsArgs): Promise<void> => {
  if (entityIds.length === 0) {
    return;
  }
  if (entityIds.length !== jobIds.length) {
    return panic("Workflow job IDs must match entity IDs");
  }

  await q.addBulk(
    entityIds.map((entityId, index) => {
      const jobId = jobIds.at(index) ?? panic("Missing workflow job ID");
      return {
        name: WORKFLOW_ENTITY_JOB_NAME,
        data: {
          workspaceId,
          organizationId,
          userId,
          entityId,
          executionPlan,
          requestId,
          runLockTtlSec,
          serviceTier,
          ...(forcePropertyIds &&
            forcePropertyIds.length > 0 && {
              forcePropertyIds: [...forcePropertyIds],
            }),
        } satisfies EntityJobData,
        opts: { jobId },
      };
    }),
  );
};

const removeQueuedWorkflowJobs = async (
  q: WorkflowEntityQueue,
  jobIds: readonly string[],
): Promise<void> => {
  for (const chunk of chunkItems(jobIds, LIMITS.workflowEntityBatchSize)) {
    await Promise.all(
      chunk.map(async (jobId) => {
        try {
          await q.remove(jobId);
        } catch (error: unknown) {
          captureError(error, { workflowJobId: jobId });
        }
      }),
    );
  }
};

const filterPlanByPropertyIds = (
  plan: ExecutionLevel[],
  propertyIds: readonly SafeId<"property">[],
): ExecutionLevel[] => {
  const allowed = new Set<string>(propertyIds);
  const filteredPlan: ExecutionLevel[] = [];
  for (const level of plan) {
    const filteredLevel: ExecutionLevel = [];
    for (const batch of level) {
      const filteredProperties = batch.properties.filter((p) =>
        allowed.has(p.id),
      );
      if (filteredProperties.length > 0) {
        filteredLevel.push({ ...batch, properties: filteredProperties });
      }
    }
    if (filteredLevel.length > 0) {
      filteredPlan.push(filteredLevel);
    }
  }
  return filteredPlan;
};

type PlanAndEnqueueWorkflowOptions = Omit<
  StartWorkflowArgs,
  "kickoff" | "runStateStore" | "serviceTier"
> & {
  requestId: SafeId<"extractionRun">;
  runStateStore: ReturnType<typeof getRootWorkflowRunStateStore>;
  serviceTier: AIRequestServiceTier;
  releaseClaimAndFail: (cause: unknown) => Promise<StartWorkflowResult>;
};

const planAndEnqueueWorkflow = async (
  {
    workspaceId,
    organizationId,
    userId,
    scopedDb,
    entityIds: inputEntityIds,
    entityIdsOrder: inputOrder,
    propertyIds: inputPropertyIds,
    serviceTier,
    runStateStore,
    extractionRunStore,
    queue,
    requestId,
    releaseClaimAndFail,
  }: PlanAndEnqueueWorkflowOptions,
  signal?: AbortSignal,
): Promise<StartWorkflowResult> => {
  const runKey = { id: requestId, organizationId, workspaceId };
  const requestIdSet = await Result.tryPromise({
    try: async () =>
      await runStateStore.setRequestId({
        requestId,
        runLockTtlSec: RUNNING_LOCK_TTL_SEC,
        workspaceId,
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(requestIdSet)) {
    return await releaseClaimAndFail(requestIdSet.error);
  }

  // Every run that plans or enqueues work has its lifecycle row, so a start
  // that cannot record its run dispatches nothing.
  const runCreated = await Result.tryPromise({
    try: async () =>
      await extractionRunStore.create({
        ...runKey,
        requestedBy: userId,
        scope: extractionRunScope({
          entityIds: inputEntityIds,
          propertyIds: inputPropertyIds,
        }),
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(runCreated)) {
    return await releaseClaimAndFail(runCreated.error);
  }

  try {
    signal?.throwIfAborted();
    const executionPlanData = await getExecutionPlanData(workspaceId, scopedDb);
    signal?.throwIfAborted();

    // Property-status freshness is an optimization for full-workspace
    // runs ("nothing changed, skip"). It must be bypassed when the
    // caller is asking for an explicit re-run: entity backfills
    // ("backfill these new rows") and column reruns ("re-extract this
    // column") both need the property in the plan even if it is
    // marked fresh. The per-entity / per-property targeting below
    // still scopes the actual computation correctly.
    const planInput =
      (inputEntityIds && inputEntityIds.length > 0) ||
      (inputPropertyIds && inputPropertyIds.length > 0)
        ? {
            ...executionPlanData,
            properties: executionPlanData.properties.map((p) => ({
              ...p,
              status: "stale" as const,
            })),
          }
        : executionPlanData;

    const fullExecutionPlan = getPropertyExecutionPlan(planInput);

    const executionPlan =
      inputPropertyIds && inputPropertyIds.length > 0
        ? filterPlanByPropertyIds(fullExecutionPlan, inputPropertyIds)
        : fullExecutionPlan;

    const hasWork = executionPlan.some((level) =>
      level.some((batch) => batch.properties.length > 0),
    );

    if (!hasWork) {
      await extractionRunStore
        .skip(runKey)
        .catch((error: unknown) => captureError(error, { workspaceId }));
      await runStateStore.clear(workspaceId);
      return { status: "skipped" };
    }
    const runLockTtlSec = computeWorkflowRunLockTtlSec(
      executionPlan,
      serviceTier,
    );
    await runStateStore.extendPlanningLease({ runLockTtlSec, workspaceId });

    const isExplicitRun =
      inputEntityIds !== undefined && inputEntityIds.length > 0;
    const fullWorkflowCreatedAtCutoff = isExplicitRun
      ? null
      : await readFullWorkflowSnapshotCursor({ scopedDb });
    const explicitEntityIds = isExplicitRun
      ? resolveWorkflowTargetEntityIds({
          entityRows: await fetchExplicitWorkflowTargetRows({
            inputEntityIds,
            scopedDb,
            workspaceId,
          }),
          inputEntityIds,
          inputOrder,
        })
      : [];
    const fullWorkflowEntityIds = isExplicitRun
      ? []
      : await collectFullWorkflowTargetIds({
          createdAtCutoff:
            fullWorkflowCreatedAtCutoff ??
            panic("Full workflow target collection requires a snapshot cursor"),
          scopedDb,
          workspaceId,
        });
    const targetEntityIds = isExplicitRun
      ? explicitEntityIds
      : fullWorkflowEntityIds;
    const targetCount = targetEntityIds.length;

    if (targetCount === 0) {
      await extractionRunStore
        .skip(runKey)
        .catch((error: unknown) => captureError(error, { workspaceId }));
      await runStateStore.clear(workspaceId);
      return { status: "skipped" };
    }

    // Finalization requires one request-bound snapshot. Keeping the scope,
    // properties, and service tier in one versioned value prevents partial
    // expiry from silently widening a run's freshness scope.
    const planPropertyIds = executionPlan.flatMap((level) =>
      level.flatMap((batch) => batch.properties.map((p) => p.id)),
    );
    const isCellScopedRun =
      inputPropertyIds &&
      inputPropertyIds.length > 0 &&
      inputEntityIds &&
      inputEntityIds.length > 0;
    await runStateStore.initializeCompletion({
      manifest: {
        version: 1,
        requestId,
        freshnessScope: isCellScopedRun ? "cells" : "workspace",
        propertyIds: planPropertyIds,
        serviceTier,
      },
      runLockTtlSec,
      targetCount,
      workspaceId,
    });

    await extractionRunStore
      .start({ ...runKey, total: targetCount })
      .catch((error: unknown) => captureError(error, { workspaceId }));

    // Broadcast running status
    broadcastWorkflowStatus(workspaceId);

    // Select once for the whole workflow. The same queue instance owns every
    // chunk and any partial-enqueue cleanup, so one request cannot straddle
    // queue classes even during a rolling routing change.
    const q =
      queue ?? getQueueForClass(workflowQueueClassForServiceTier(serviceTier));
    const queuedJobIds: string[] = [];
    try {
      for (const chunk of chunkItems(
        targetEntityIds,
        LIMITS.workflowEntityBatchSize,
      )) {
        const chunkJobIds = chunk.map((entityId) =>
          workflowEntityJobId({ entityId, requestId }),
        );
        queuedJobIds.push(...chunkJobIds);
        signal?.throwIfAborted();
        await enqueueEntityJobs({
          entityIds: chunk,
          executionPlan,
          jobIds: chunkJobIds,
          organizationId,
          q,
          requestId,
          runLockTtlSec,
          serviceTier,
          userId,
          workspaceId,
          ...(inputPropertyIds &&
            inputPropertyIds.length > 0 && {
              forcePropertyIds: inputPropertyIds,
            }),
        });
      }
    } catch (error: unknown) {
      await removeQueuedWorkflowJobs(q, queuedJobIds);
      throw error;
    }

    return { status: "started" };
  } catch (error: unknown) {
    await extractionRunStore
      .fail({ ...runKey, errorCode: errorTag(error) })
      .catch((runError: unknown) => captureError(runError, { workspaceId }));
    await runStateStore.clear(workspaceId);
    broadcastWorkflowStatus(workspaceId);
    captureError(error, { workspaceId });
    return { status: "failed" };
  }
};

/**
 * Start a workflow: build execution plan, enqueue entity jobs.
 */
export const startWorkflow = async ({
  workspaceId,
  organizationId,
  userId,
  scopedDb,
  entityIds: inputEntityIds,
  entityIdsOrder: inputOrder,
  propertyIds: inputPropertyIds,
  serviceTier = "standard",
  runStateStore = getRootWorkflowRunStateStore(),
  extractionRunStore,
  kickoff = runQueuedKickoff,
  queue,
}: StartWorkflowArgs): Promise<StartWorkflowResult> => {
  const requestId = createSafeId<"extractionRun">();

  // Check if already running (atomic check-and-set). The TTL is the
  // safety net for an uncleanly-killed worker; tuned tight enough that
  // a recovered workspace doesn't sit blocked for hours.
  const wasSet = await runStateStore.tryClaim({
    requestId,
    runLockTtlSec: RUNNING_LOCK_TTL_SEC,
    workspaceId,
  });
  if (!wasSet) {
    return { status: "already-running" };
  }

  // Recording a claimed run can fail before planning starts. Release only
  // this request's claim and report the same in-band failure as enqueueing.
  // Release is best-effort on a failed connection; the claim TTL and orphan
  // reconciliation remain the backstop.
  const releaseClaimAndFail = async (
    cause: unknown,
  ): Promise<StartWorkflowResult> => {
    // Compare-and-delete on this request's own id: the release runs after a
    // failure, so by the time it lands the claim's TTL may have lapsed and a
    // replacement run may hold the workspace. Releasing that one would hand a
    // third caller a workspace two runs believe they own.
    await runStateStore
      .releaseClaim({ requestId, workspaceId })
      .catch((releaseError: unknown) =>
        captureError(releaseError, { workspaceId }),
      );
    captureError(cause, { workspaceId });
    return { status: "failed" };
  };

  const planAndEnqueue = async (signal?: AbortSignal) =>
    await planAndEnqueueWorkflow(
      {
        workspaceId,
        organizationId,
        userId,
        scopedDb,
        serviceTier,
        runStateStore,
        extractionRunStore,
        requestId,
        releaseClaimAndFail,
        ...(inputEntityIds !== undefined && { entityIds: inputEntityIds }),
        ...(inputOrder !== undefined && { entityIdsOrder: inputOrder }),
        ...(inputPropertyIds !== undefined && {
          propertyIds: inputPropertyIds,
        }),
        ...(queue !== undefined && { queue }),
      },
      signal,
    );
  const started = await Result.tryPromise({
    try: async () =>
      await kickoff({
        organizationId,
        userId,
        organizationStateDb: scopedDb,
        actionKind: QUEUED_ACTION_KIND.extraction,
        logicalPhaseId: requestId,
        run: planAndEnqueue,
      }),
    catch: (cause) => cause,
  });
  if (Result.isOk(started)) {
    return started.value;
  }
  return await releaseClaimAndFail(started.error);
};

// ── Orphan reconciliation ──────────────────────────────
//
// A workflow's Redis run-state can outlive the worker that owns it when
// the API process dies mid-job — a `bun --watch` hot-reload on save, an
// OOM, a `kill -9`, or SIGTERM on deploy. The job is abandoned after its
// cells were set to `pending` but before `finishWorkflow` clears the
// lock, and a hard kill emits no BullMQ `failed` event, so neither the
// `running` lock nor the `pending` cells self-heal: every retry is
// rejected with a 409 until the hour-long lock TTL lapses, and the cells
// spin forever. The reconciler closes that gap. Any workspace holding a
// `running` lock or owning `pending` cells with no in-flight queue job is
// orphaned; its pending cells are flipped to `error` (still re-runnable)
// and its run-state cleared. Death-cause-agnostic: the next worker boot
// heals whatever the previous one left behind.

const RECONCILE_INTERVAL_MS = 60 * 1000;
const STALE_ACTIVE_RUN_SCAN_LIMIT = 1000;
// Settle window before acting. A workflow that has just taken its
// `running` lock but not yet enqueued its first entity batch would look
// orphaned for a moment; we re-confirm against a fresh job snapshot after
// this delay so a starting run is never reconciled away.
const RECONCILE_SETTLE_MS = 5 * 1000;
// Non-terminal BullMQ states. A job in any of these means the workspace
// still has reclaimable work in flight, so its run-state is legitimate.
// BullMQ 6 dropped the separate `paused` state: a paused queue's jobs are
// reported as `waiting`, which this list already covers.
const LIVE_JOB_STATES = [
  "active",
  "waiting",
  "delayed",
  "prioritized",
  "waiting-children",
] as const;
// Upper bound on the live-job snapshot. If the queue holds more in-flight
// jobs than this, skip the cycle rather than risk treating a busy
// workspace as orphaned from a truncated scan — a false positive must
// never clobber a healthy run. A later, quieter cycle reconciles it.
const snapshotLiveWorkspaceIds = async () => {
  const jobSnapshots = await Promise.all(
    getAllWorkflowQueues().map(
      async (queue) =>
        await queue.getJobs(
          [...LIVE_JOB_STATES],
          0,
          LIMITS.workflowLiveJobScanLimit - 1,
        ),
    ),
  );
  return combineLiveWorkflowJobSnapshots({
    jobSnapshots,
    scanLimit: LIMITS.workflowLiveJobScanLimit,
  });
};

const readWorkflowRequestIds = async (
  workspaceIds: readonly string[],
): Promise<Map<string, string | null>> => {
  const runStateStore = getRootWorkflowRunStateStore();
  const requestIds = new Map<string, string | null>();
  for (const workspaceIdBatch of chunkItems(
    workspaceIds,
    LIMITS.workflowEntityBatchSize,
  )) {
    await Promise.all(
      workspaceIdBatch.map(async (id) => {
        const requestId = await runStateStore.getRequestId(
          brandPersistedWorkspaceId(id),
        );
        requestIds.set(id, requestId);
      }),
    );
  }
  return requestIds;
};

const readWorkflowRunningValues = async (
  workspaceIds: readonly string[],
): Promise<Map<string, string | null>> => {
  const runStateStore = getRootWorkflowRunStateStore();
  const runningValues = new Map<string, string | null>();
  for (const workspaceIdBatch of chunkItems(
    workspaceIds,
    LIMITS.workflowEntityBatchSize,
  )) {
    await Promise.all(
      workspaceIdBatch.map(async (id) => {
        const runningValue = await runStateStore.getRunningValue(
          brandPersistedWorkspaceId(id),
        );
        runningValues.set(id, runningValue);
      }),
    );
  }
  return runningValues;
};

type ShouldRecoverWorkflowOptions = {
  expectedRequestId: string | null;
  workspaceId: SafeId<"workspace">;
};

const shouldRecoverWorkflow = async ({
  expectedRequestId,
  workspaceId,
}: ShouldRecoverWorkflowOptions): Promise<boolean> =>
  await getRootWorkflowRunStateStore().reserveForRecovery({
    expectedRequestId,
    recoveryLockValue: RECOVERY_LOCK_VALUE,
    runLockTtlSec: RUNNING_LOCK_TTL_SEC,
    workspaceId,
  });

/**
 * What orphan reconciliation works through: the workers' connection, for its
 * cell reads and writes, and the run store built over that same connection.
 */
type OrphanReconciliationWorker = {
  database: OrphanCellsDatabase;
  extractionRuns: ExtractionRunStore;
};

type RecoverOrphanedWorkflowOptions = OrphanReconciliationWorker & {
  expectedRequestId: string | null;
  workspaceId: SafeId<"workspace">;
};

const recoverOrphanedWorkflow = async ({
  database,
  expectedRequestId,
  extractionRuns,
  workspaceId,
}: RecoverOrphanedWorkflowOptions): Promise<void> => {
  const shouldRecover = await shouldRecoverWorkflow({
    expectedRequestId,
    workspaceId,
  });
  if (!shouldRecover) {
    return;
  }

  // Error the stuck `pending` cells first, while the orphaned lock still
  // blocks any new run from re-populating them. `error` cells stay
  // eligible for re-extraction (see `prepareBatch`), so a retry or the
  // next full run picks them back up.
  const erroredFields = await errorPendingCells(database, workspaceId);

  await extractionRuns
    .failActiveForWorkspace({
      errorCode: "ExtractionRunOrphaned",
      workspaceId,
    })
    .catch((error: unknown) => captureError(error, { workspaceId }));

  // Then release the run-state so retries / new runs stop hitting the
  // "a workflow is already running" 409.
  await getRootWorkflowRunStateStore().clear(workspaceId);

  logger.warn("workflow.orphan_reconciled", {
    workspaceId,
    erroredFields: String(erroredFields),
  });

  // Push the cleared status + errored cells to any connected client.
  broadcastWorkflowStatus(workspaceId);
};

type ReconcileOrphanedWorkflowsOptions = {
  // Boot passes `true` to also sweep the DB for `pending` cells whose
  // lock already lapsed via TTL. Every tick still performs the bounded,
  // indexed stale-run scan because a captured terminal ledger-write failure
  // can leave no Redis or pending-cell recovery signal.
  scanPendingCells: boolean;
};

/**
 * Reconcile workflows orphaned by a killed worker. Safe to call
 * repeatedly; a no-op when nothing is orphaned. Exported for the boot +
 * interval wiring in `initWorkflowWorkers` and for operational scripts.
 */
export const reconcileOrphanedWorkflows = async (
  { scanPendingCells }: ReconcileOrphanedWorkflowsOptions,
  { database, extractionRuns }: OrphanReconciliationWorker,
): Promise<void> => {
  const lockedWorkspaceIds =
    await getRootWorkflowRunStateStore().scanRunningWorkspaceIds();
  const pendingWorkspaceIds = scanPendingCells
    ? await selectWorkspacesWithPendingCells(database)
    : await selectWorkspacesWithPendingCells(database, lockedWorkspaceIds);
  const staleActiveWorkspaceIds =
    await extractionRuns.listStaleActiveWorkspaceIds({
      before: new Date(
        Temporal.Now.instant().epochMilliseconds - RUNNING_LOCK_TTL_SEC * 1000,
      ),
      limit: STALE_ACTIVE_RUN_SCAN_LIMIT,
    });

  const candidateWorkspaceIds = [
    ...lockedWorkspaceIds,
    ...pendingWorkspaceIds,
    ...staleActiveWorkspaceIds,
  ];
  if (candidateWorkspaceIds.length === 0) {
    return;
  }

  const live = await snapshotLiveWorkspaceIds();
  if (live.truncated) {
    logger.warn("workflow.reconcile_skipped_backlog", {
      candidates: String(candidateWorkspaceIds.length),
    });
    return;
  }

  const orphanCandidates = selectOrphanWorkspaceIds({
    candidateWorkspaceIds,
    liveWorkspaceIds: live.workspaceIds,
  });
  if (orphanCandidates.length === 0) {
    return;
  }

  const initialRequestIds = await readWorkflowRequestIds(orphanCandidates);

  // Re-confirm after a settle delay so a workflow that is mid-startup
  // (lock taken, first batch not yet enqueued) is not mistaken for an
  // orphan.
  await sleep(RECONCILE_SETTLE_MS);
  const confirmed = await snapshotLiveWorkspaceIds();
  if (confirmed.truncated) {
    return;
  }

  // Independent reads of two distinct Redis keys per workspace; neither
  // depends on the other's result.
  const [currentRequestIds, currentRunningValues] = await Promise.all([
    readWorkflowRequestIds(orphanCandidates),
    readWorkflowRunningValues(orphanCandidates),
  ]);
  // Pending cells are immediate recovery evidence. A stale durable row is
  // evidence only once both Redis state keys have actually expired: flex runs
  // can legitimately extend their lock beyond the row-age threshold before
  // their first queue job exists.
  const expiredStaleWorkspaceIds = selectExpiredStaleRunWorkspaceIds({
    currentRequestIds,
    currentRunningValues,
    staleWorkspaceIds: staleActiveWorkspaceIds,
  });
  const recoveryEvidenceWorkspaceIdSet = new Set([
    ...pendingWorkspaceIds,
    ...expiredStaleWorkspaceIds,
  ]);
  const recoveryWorkspaceIds = new Set<string>();
  for (const workspaceId of orphanCandidates) {
    if (currentRunningValues.get(workspaceId) === RECOVERY_LOCK_VALUE) {
      recoveryWorkspaceIds.add(workspaceId);
    }
  }
  const recoverableOrphans = selectRecoverableOrphanWorkspaceIds({
    candidateWorkspaceIds: orphanCandidates,
    currentRequestIds,
    initialRequestIds,
    liveWorkspaceIds: confirmed.workspaceIds,
    pendingWorkspaceIds: recoveryEvidenceWorkspaceIdSet,
    recoveryWorkspaceIds,
  });

  for (const workspaceId of recoverableOrphans) {
    // db-await-in-loop: each orphan is recovered only after its own run-lock re-check, and its recovery ends in that workspace's run-state clear and broadcast; the steps are ordered per workspace and cannot share one statement
    await recoverOrphanedWorkflow({
      database,
      expectedRequestId: currentRequestIds.get(workspaceId) ?? null,
      extractionRuns,
      workspaceId: brandPersistedWorkspaceId(workspaceId),
    });
  }
};

// ── Worker ─────────────────────────────────────────────

const processWorkflowJob = async (
  job: WorkflowEntityJob,
  extractionRuns: ExtractionRunStore,
): Promise<void> => {
  // Hard process-level timeout. A hung AI provider, a runaway batch, or a
  // broken external call would otherwise keep the job "active" indefinitely.
  // The signal reaches the provider, so a retry cannot race abandoned work.
  const controller = new AbortController();
  const jobTimeoutMs = computeWorkflowJobTimeoutMs(
    job.data.executionPlan,
    job.data.serviceTier ?? "standard",
  );
  const timeoutHandle = setTimeout(() => {
    controller.abort(
      new TimeoutError({
        label: "workflow.job",
        message: `workflow.job_timeout: entity ${job.data.entityId} exceeded ${jobTimeoutMs}ms`,
        timeoutMs: jobTimeoutMs,
      }),
    );
  }, jobTimeoutMs);
  const actor = workflowRunActor(job.data);
  try {
    await runBackgroundJob({
      actionKind: BACKGROUND_ACTION_KIND.extraction,
      organizationId: actor.organizationId,
      userId: actor.userId,
      job,
      signal: controller.signal,
      run: async (signal, admission) =>
        await processWorkflowEntityRun({
          actor,
          admission,
          data: job.data,
          signal,
          extractionRuns,
        }),
    });
    controller.signal.throwIfAborted();
  } finally {
    clearTimeout(timeoutHandle);
  }
};

const pendingFailedJobFinalizations = new Set<Promise<void>>();

const trackFailedJobFinalization = (work: Promise<void>): void => {
  const tracked = work.finally(() => {
    pendingFailedJobFinalizations.delete(tracked);
  });
  pendingFailedJobFinalizations.add(tracked);
};

const handleWorkflowJobFailed = (
  job: WorkflowEntityJob | undefined,
  error: Error,
  extractionRuns: ExtractionRunStore,
): void => {
  if (!job) {
    return;
  }
  const data = job.data;
  logger.error("workflow.entity_failed", {
    workspaceId: data.workspaceId,
    entityId: data.entityId,
    attemptsMade: String(job.attemptsMade),
    "error.type": errorTag(error),
  });

  // With `attempts: 2` enabled on the queue, the failed event fires for
  // transient first-attempt failures too. Only count the entity once BullMQ
  // has exhausted retries, or the workflow could finalize mid-retry.
  const totalAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < totalAttempts) {
    return;
  }

  const actor = workflowRunActor(data);
  trackFailedJobFinalization(
    (async () => {
      const isCurrentRequest = await isCurrentWorkflowRequest({
        requestId: actor.runId,
        workspaceId: actor.workspaceId,
      });
      if (!isCurrentRequest) {
        return;
      }

      await failEntity({
        actor,
        data,
        errorCode: errorTag(error),
        extractionRuns,
      });
    })().catch((completionError: unknown) => {
      captureError(completionError, {
        workspaceId: data.workspaceId,
        entityId: data.entityId,
      });
    }),
  );
};

// The Bun-adapter poll blip (see `isRecoverableRedisPollError`) recurs every
// few seconds, so warn once per interval rather than per occurrence, carrying
// the tally so a rising real problem is still visible.
const REDIS_POLL_WARN_INTERVAL_MS = 60 * 1000;

const createWorkflowWorker = (
  { concurrency, queueClass }: WorkflowWorkerSpec,
  extractionRuns: ExtractionRunStore,
): WorkflowEntityWorker => {
  const queueName = WORKFLOW_QUEUE_NAMES[queueClass];
  // Every BullMQ Worker uses blocking commands, so each queue needs its own
  // dedicated connection rather than the producer's shared connection.
  const worker = new BullMqWorker<EntityJobData, void, WorkflowEntityJobName>(
    queueName,
    async (job) => {
      await processWorkflowJob(job, extractionRuns);
    },
    {
      connection: createBullMqConnection({
        storeClass: "durable-coordination",
      }),
      concurrency,
      lockDuration: LOCK_DURATION_MS,
      stalledInterval: STALLED_INTERVAL_MS,
      maxStalledCount: MAX_STALLED_COUNT,
    },
  );

  worker.on("failed", (job, error) => {
    handleWorkflowJobFailed(job, error, extractionRuns);
  });
  // Per-worker rate-limit state for the recoverable Bun-adapter poll blip:
  // count every occurrence but emit at most one warn per interval, carrying
  // the tally so a rising real problem is still visible.
  let redisPollBlipsSinceWarn = 0;
  let redisPollLastWarnAtMs = 0;
  const logWorkerError = createQueueWorkerErrorLogger("workflow.worker_error", {
    queueClass,
    queue: queueName,
  });
  worker.on("error", (error) => {
    if (isRecoverableRedisPollError(error)) {
      redisPollBlipsSinceWarn += 1;
      const nowMs = Temporal.Now.instant().epochMilliseconds;
      if (nowMs - redisPollLastWarnAtMs < REDIS_POLL_WARN_INTERVAL_MS) {
        return;
      }
      redisPollLastWarnAtMs = nowMs;
      logger.warn("workflow.worker_redis_poll_blip", {
        ...connectionErrorFields(error),
        queueClass,
        queue: queueName,
        blipsSinceLastWarn: String(redisPollBlipsSinceWarn),
      });
      redisPollBlipsSinceWarn = 0;
      return;
    }
    logWorkerError(error);
  });
  logger.info("workflow.worker_started", {
    concurrency: String(concurrency),
    queueClass,
    queue: queueName,
  });
  return worker;
};

/**
 * Grade one reconcile tick's failure.
 *
 * The tick opens on a Redis scan, which rejects with a closed-connection code
 * when the socket dropped while idle. The client reconnects without an attempt
 * cap and its holder replaces a client that closed anyway, so the next tick
 * runs against a live connection and that rejection is an expected operational
 * transient rather than a defect. Anything else is a fault the tick could not
 * recover from and stays a captured exception. Same split the
 * document-processing reconcile applies to its own tick.
 *
 * Exported for the test that pins the split.
 */
export const handleWorkflowReconcileFailure = (error: unknown): void => {
  if (isTransientRedisConnectionError(error)) {
    logger.warn("workflow.reconcile_disrupted", {
      "error.type": errorTag(error),
    });
    return;
  }
  captureError(error);
  logger.error("workflow.reconcile_failed", errorSystemFields(error));
};

/**
 * Drive the reconcile cadence.
 *
 * The thorough pass — the unbounded DB sweep for pending cells whose lock has
 * already lapsed — is owed once per process, and only a completed tick
 * discharges it. A tick that rejects, including on the transient graded above,
 * leaves it owed so the next tick repeats the sweep rather than deferring it to
 * the next restart; later ticks look for pending cells only under a held Redis
 * lock, so the sweep has no equivalent.
 */
export const createWorkflowReconcileRunner = (
  reconcile: (options: ReconcileOrphanedWorkflowsOptions) => Promise<void>,
) => {
  let pendingCellSweepOwed = true;
  const runTick = async (): Promise<void> => {
    await reconcile({ scanPendingCells: pendingCellSweepOwed });
    pendingCellSweepOwed = false;
  };
  return (): void => {
    runTick().catch(handleWorkflowReconcileFailure);
  };
};

/**
 * Initialize every workflow worker. Call once at API startup. The run
 * lifecycle store is built once, over the connection the host hands in, and
 * shared by every worker and the orphan reconciler for their lifetime.
 */
export const initWorkflowWorkers = ({ db }: BullMqWorkerContext) => {
  const extractionRuns = createExtractionRunStore(db);
  const workers = WORKFLOW_WORKER_SPECS.map((spec) =>
    createWorkflowWorker(spec, extractionRuns),
  );

  // Heal whatever a previously-killed worker left orphaned. Boot runs a
  // thorough pass (also sweeping the DB for pending cells whose lock has
  // already lapsed); the interval then catches orphans that form at
  // runtime — e.g. a job exhausts its retries while the lock is held —
  // without waiting for a restart.
  const runReconcile = createWorkflowReconcileRunner(
    async (options) =>
      await reconcileOrphanedWorkflows(options, {
        database: db,
        extractionRuns,
      }),
  );
  runReconcile();
  const reconcileTimer = setInterval(runReconcile, RECONCILE_INTERVAL_MS);
  // The reconcile cadence must not keep the process alive at shutdown.
  reconcileTimer.unref();

  return {
    queues: WORKFLOW_WORKER_SPECS.map(
      (spec) => WORKFLOW_QUEUE_NAMES[spec.queueClass],
    ),
    close: async (): Promise<void> => {
      clearInterval(reconcileTimer);
      const closeResults = await Promise.allSettled(
        workers.map(async (worker) => await worker.close()),
      );
      for (const result of closeResults) {
        if (result.status === "rejected") {
          captureError(result.reason);
        }
      }
      await Promise.allSettled([...pendingFailedJobFinalizations]);
    },
  };
};

// ── Entity processing ──────────────────────────────────

const getPlanPropertyIds = (
  executionPlan: ExecutionLevel[],
): SafeId<"property">[] => {
  const propertyIds = new Set<SafeId<"property">>();

  for (const level of executionPlan) {
    for (const batch of level) {
      for (const property of batch.properties) {
        propertyIds.add(brandPersistedPropertyId(property.id));
      }
    }
  }

  return [...propertyIds];
};

const markPendingPlannedFieldsErrored = async (
  actor: WorkflowRunActor,
  data: EntityJobData,
) => {
  const entityId = brandPersistedEntityId(data.entityId);
  const propertyIds = getPlanPropertyIds(data.executionPlan);
  if (propertyIds.length === 0) {
    return;
  }

  const entityRow = await actor.writeDb((tx) =>
    tx.query.entities.findFirst({
      where: { id: { eq: entityId } },
      columns: { currentVersionId: true },
    }),
  );
  if (!entityRow?.currentVersionId) {
    return;
  }
  const entityVersionId = entityRow.currentVersionId;

  await actor.writeDb((tx) =>
    tx
      .update(fields)
      .set({ content: { type: "error", version: 1 } })
      .where(
        and(
          eq(fields.entityVersionId, entityVersionId),
          inArray(fields.propertyId, propertyIds),
          sql`${fields.content}->>'type' = 'pending'`,
        ),
      ),
  );

  broadcastWorkspaceResourceSetUpdated(actor.workspaceId, RESOURCE_TYPE.ENTITY);
};

type FailEntityOptions = {
  actor: WorkflowRunActor;
  data: EntityJobData;
  errorCode: string;
  extractionRuns: ExtractionRunStore;
};

/**
 * End one entity of the run in error: its pending cells become `error`, the
 * run records the failure, and the entity counts as done so the run still
 * finalizes.
 */
const failEntity = async ({
  actor,
  data,
  errorCode,
  extractionRuns,
}: FailEntityOptions): Promise<void> => {
  await markPendingPlannedFieldsErrored(actor, data).catch(
    (pendingFieldsError: unknown) => {
      captureError(pendingFieldsError, {
        workspaceId: data.workspaceId,
        entityId: data.entityId,
      });
    },
  );
  await extractionRuns
    .recordFailure({
      id: actor.runId,
      organizationId: actor.organizationId,
      workspaceId: actor.workspaceId,
      errorCode,
    })
    .catch((runError: unknown) =>
      captureError(runError, {
        workspaceId: data.workspaceId,
        entityId: data.entityId,
      }),
    );
  await onEntityCompleted({
    actor,
    extractionRuns,
    entityId: brandPersistedEntityId(data.entityId),
    runLockTtlSec: data.runLockTtlSec ?? RUNNING_LOCK_TTL_SEC,
  });
};

type ProcessWorkflowEntityRunOptions = {
  actor: WorkflowRunActor;
  /** The background job's admission; the run's period action was drawn at kickoff. */
  admission: ModelDispatchAdmission;
  data: EntityJobData;
  signal: AbortSignal;
  extractionRuns: ExtractionRunStore;
};

/**
 * Run one entity's share of a workflow as its requester. A requester who can
 * no longer open the matter ends the entity in error before any input is read
 * or any model is called.
 */
export const processWorkflowEntityRun = async ({
  actor,
  admission,
  data,
  signal,
  extractionRuns,
}: ProcessWorkflowEntityRunOptions) => {
  const {
    entityId,
    executionPlan,
    serviceTier = "standard",
    forcePropertyIds,
  } = data;
  const forcedPropertyIds: ReadonlySet<string> = new Set(forcePropertyIds);
  const brandedEntityId = brandPersistedEntityId(entityId);

  const isCurrentRequest = await isCurrentWorkflowRequest({
    requestId: actor.runId,
    workspaceId: actor.workspaceId,
  });
  if (!isCurrentRequest) {
    return;
  }

  if (!(await requesterCanOpenMatter(actor))) {
    await failEntity({
      actor,
      data,
      errorCode: INPUTS_UNAVAILABLE_ERROR_CODE,
      extractionRuns,
    });
    return;
  }

  for (let level = 0; level < executionPlan.length; level++) {
    const isStillCurrentRequest = await isCurrentWorkflowRequest({
      requestId: actor.runId,
      workspaceId: actor.workspaceId,
    });
    if (!isStillCurrentRequest) {
      return;
    }

    // Honour the worker-level timeout. Throwing here ensures we don't
    // start a new batch (or call onEntityCompleted) after the abort.
    signal.throwIfAborted();

    const batches = executionPlan[level];
    if (!batches || batches.length === 0) {
      continue;
    }

    // Each level reads anew, so access is settled again before it; level 0
    // was settled above.
    // db-await-in-loop: one access check per dependency level, which must run before that level's reads
    if (level > 0 && !(await requesterCanOpenMatter(actor))) {
      signal.throwIfAborted();
      await failEntity({
        actor,
        data,
        errorCode: INPUTS_UNAVAILABLE_ERROR_CODE,
        extractionRuns,
      });
      return;
    }

    // Process all batches at this level in parallel
    // (same level = independent dependencies)
    const drained = await drainFanOut({
      items: batches,
      signal,
      operation: async (batch, batchSignal) =>
        await processOneBatch({
          actor,
          admission,
          entityId: brandedEntityId,
          batch,
          level,
          signal: batchSignal,
          serviceTier,
          forcedPropertyIds,
        }),
    });
    if (Result.isError(drained)) {
      throw drained.error;
    }
  }

  // Final checkpoint — if abort fired between the last batch and
  // here, skip the broadcast + completion increment so the retry
  // owns the finalization.
  signal.throwIfAborted();

  broadcastWorkspaceResourceSetUpdated(actor.workspaceId, RESOURCE_TYPE.ENTITY);

  await onEntityCompleted({
    actor,
    extractionRuns,
    entityId: brandedEntityId,
    runLockTtlSec: data.runLockTtlSec ?? RUNNING_LOCK_TTL_SEC,
  });
};

type ProcessOneBatchArgs = {
  actor: WorkflowRunActor;
  admission: ModelDispatchAdmission;
  entityId: SafeId<"entity">;
  batch: PropertyBatch;
  level: number;
  signal: AbortSignal;
  serviceTier: AIRequestServiceTier;
  forcedPropertyIds: ReadonlySet<string>;
};

type BatchPreviewPublisherArgs = {
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  propertyIds: SafeId<"property">[];
};

const createBatchPreviewPublisher = ({
  workspaceId,
  entityId,
  entityVersionId,
  propertyIds,
}: BatchPreviewPublisherArgs) => {
  const propertyIdSet = new Set(propertyIds);
  const lastAnswers = new Map<SafeId<"property">, string>();
  const lastSentAt = new Map<SafeId<"property">, number>();

  const broadcastPreview = (payload: ExtractionPreviewPayload) => {
    broadcast(workspaceId, {
      type: EXTRACTION_PREVIEW_EVENT_TYPE,
      data: payload,
    });
  };

  const publish = (update: PartialAnswerUpdate): void => {
    const propertyId = brandPersistedPropertyId(update.propertyId);
    if (!propertyIdSet.has(propertyId)) {
      return;
    }

    const answer = update.answer.trim();
    if (answer.length === 0 || lastAnswers.get(propertyId) === answer) {
      return;
    }

    const now = Temporal.Now.instant().epochMilliseconds;
    const previousSentAt = lastSentAt.get(propertyId);
    if (
      previousSentAt !== undefined &&
      now - previousSentAt < EXTRACTION_PREVIEW_THROTTLE_MS
    ) {
      return;
    }

    lastAnswers.set(propertyId, answer);
    lastSentAt.set(propertyId, now);

    const payload: ExtractionPreviewPayload = {
      entityId,
      entityVersionId,
      propertyId,
      answer,
      status: "streaming",
    };

    broadcastPreview(payload);
  };

  const clear = (): void => {
    for (const propertyId of propertyIds) {
      broadcastPreview({
        entityId,
        entityVersionId,
        propertyId,
        answer: null,
        status: "clear",
      });
    }
  };

  return { clear, publish };
};

const processOneBatch = async ({
  actor,
  admission,
  entityId,
  batch: rawBatch,
  level,
  signal,
  serviceTier,
  forcedPropertyIds,
}: ProcessOneBatchArgs) => {
  const { workspaceId, organizationId, userId, runId: requestId } = actor;
  signal.throwIfAborted();
  const isCurrentRequest = await isCurrentWorkflowRequest({
    requestId,
    workspaceId,
  });
  if (!isCurrentRequest) {
    return;
  }

  const entityRow = await actor.inputDb((tx) =>
    tx.query.entities.findFirst({
      columns: { currentVersionId: true },
      where: { id: { eq: entityId } },
    }),
  );

  if (!entityRow?.currentVersionId) {
    return; // Entity deleted mid-workflow
  }

  const entityVersionId = entityRow.currentVersionId;
  const propertyIds = rawBatch.properties.map((p) => p.id);

  // Get existing field content for skip logic
  const batchFields = await actor.inputDb((tx) =>
    tx
      .select({
        propertyId: fields.propertyId,
        contentType: jsonField(fields.content, "v1")("type"),
      })
      .from(fields)
      .where(
        and(
          eq(fields.entityVersionId, entityVersionId),
          inArray(fields.propertyId, propertyIds),
        ),
      ),
  );

  const fieldContentMap = new Map<SafeId<"property">, FieldContent["type"]>(
    batchFields.map((f) => [f.propertyId, f.contentType]),
  );

  const lockedCellRows = await actor.inputDb((tx) =>
    tx
      .select({
        propertyId: cellMetadata.propertyId,
        metadata: cellMetadata.metadata,
      })
      .from(cellMetadata)
      .where(
        and(
          eq(cellMetadata.entityVersionId, entityVersionId),
          inArray(cellMetadata.propertyId, propertyIds),
        ),
      ),
  );
  const lockedPropertyIds = new Set<string>();
  for (const row of lockedCellRows) {
    if (row.metadata.locked === true) {
      lockedPropertyIds.add(row.propertyId);
    }
  }

  const batch = prepareBatch(
    rawBatch,
    fieldContentMap,
    lockedPropertyIds,
    forcedPropertyIds,
  );

  if (batch.properties.length === 0) {
    return;
  }

  const previewPublisher = createBatchPreviewPublisher({
    workspaceId,
    entityId,
    entityVersionId,
    propertyIds: batch.properties.map((property) => property.id),
  });

  try {
    // Set fields to "pending"
    await setFieldsStatus({
      workspaceId,
      entityVersionId,
      batch,
      contentType: "pending",
      writeDb: actor.writeDb,
    });

    // Broadcast so the frontend shows pending state.
    broadcastWorkspaceResourceSetUpdated(workspaceId, RESOURCE_TYPE.ENTITY);

    const settings = await actor.writeDb(
      async (tx) => await loadOrgAISettings(tx, { organizationId, userId }),
    );
    if (Result.isError(settings)) {
      throw settings.error;
    }
    const { orgAIConfig, managedAIResidency, promptCachingEnabled } =
      settings.value;
    const generateFn = getBatchGenerator();

    // Dispatch on tool type: ai-model columns run the LLM extraction; verdict
    // columns are graded by the verdict engine from their ASK property's
    // already-written value. A level rarely mixes both (their dependency
    // signatures differ), but split defensively so each path only sees the
    // properties it can process.
    const aiModelProperties = batch.properties.filter(
      (property): property is AIBatchProperty =>
        property.tool.type === "ai-model",
    );
    const verdictProperties = batch.properties.filter(
      (property): property is VerdictBatchProperty =>
        property.tool.type === "playbook-verdict",
    );

    const aiResults: AIResult[] = [];
    const aiJustifications: AIJustification[] = [];
    const skippedPropertyIds: SafeId<"property">[] = [];
    const unsupportedPropertyIds: SafeId<"property">[] = [];
    const erroredProperties: BatchProperty[] = [];
    const usageMetering = {
      actionType: "background" as const,
      organizationId,
      safeDb: actor.writeSafeDb,
      serviceTier,
      userId,
      workspaceId,
    };

    if (aiModelProperties.length > 0) {
      const aiBatch: PropertyBatch = {
        ...batch,
        properties: aiModelProperties,
      };
      // generateBatch returns a Result<T, E> directly. Only the worker-level
      // per-job timeout is applied here: a batch is no longer one model
      // request, because `generateWorkflowData` splits it into as many
      // requests as the provider's schema budget allows. It applies the
      // per-request AI timeout to each of those, which is the only place the
      // request count is known; applying it to the whole batch here would
      // abort a large batch partway through its first minutes.
      const batchResult = await runWorkflowBatchGenerationWithRetry({
        generate: async () =>
          await generateFn({
            abortSignal: signal,
            admission,
            batch: aiBatch,
            entityVersionId,
            organizationId,
            workspaceId,
            scopedDb: actor.inputDb,
            orgAIConfig,
            managedAIResidency,
            promptCachingEnabled,
            serviceTier,
            usageMetering,
            onPartialAnswer: previewPublisher.publish,
          }),
        onRetryError: (error, attempt) => {
          captureError(error, {
            workspaceId,
            entityId,
            batchId: batch.id,
            level: String(level),
            requestId,
            attempt: String(attempt),
            retry: "true",
          });
        },
        sleep,
        throwIfAborted: () => signal.throwIfAborted(),
      });

      if (Result.isError(batchResult)) {
        captureError(batchResult.error, {
          workspaceId,
          entityId,
          batchId: batch.id,
          level: String(level),
          requestId,
        });
        erroredProperties.push(...aiModelProperties);
      } else {
        aiResults.push(...batchResult.value.aiResults);
        aiJustifications.push(...batchResult.value.aiJustifications);
        skippedPropertyIds.push(...batchResult.value.skippedPropertyIds);
        unsupportedPropertyIds.push(
          ...batchResult.value.unsupportedPropertyIds,
        );
      }
    }

    if (verdictProperties.length > 0) {
      signal.throwIfAborted();
      const verdictOutput = await computeVerdictBatch({
        admission,
        abortSignal: AbortSignal.any([
          AbortSignal.timeout(getWorkflowBatchAITimeoutMs(serviceTier)),
          signal,
        ]),
        organizationId,
        workspaceId,
        scopedDb: actor.inputDb,
        entityVersionId,
        verdictProperties,
        inputPropertyIds: batch.inputs,
        orgAIConfig,
        managedAIResidency,
        promptCachingEnabled,
        serviceTier,
        usageMetering,
      });
      aiResults.push(...verdictOutput.aiResults);
      aiJustifications.push(...verdictOutput.aiJustifications);
      skippedPropertyIds.push(...verdictOutput.skippedPropertyIds);
      const erroredVerdictIds = new Set<string>(
        verdictOutput.erroredPropertyIds,
      );
      for (const property of verdictProperties) {
        if (erroredVerdictIds.has(property.id)) {
          erroredProperties.push(property);
        }
      }

      // Commit the same verdicts as durable findings on this document's review
      // run, if the playbook that started them created one. The cells above are
      // the table's projection; the findings are the record that outlives the
      // columns, so a failure here must not fail the extraction that produced
      // them — it is reported and the batch continues.
      const recorded = await Result.tryPromise({
        try: async () =>
          await recordTableRunVerdicts({
            scopedDb: actor.writeDb,
            organizationId,
            workspaceId,
            entityId,
            entityVersionId,
            graded: verdictOutput.gradedVerdicts,
            unresolvedPropertyIds: [
              ...verdictOutput.skippedPropertyIds,
              ...verdictOutput.erroredPropertyIds,
            ],
          }),
        catch: (cause) => cause,
      });
      if (Result.isError(recorded)) {
        captureError(recorded.error, {
          workspaceId,
          entityId,
          batchId: batch.id,
          operation: "document_review_run.table_findings",
        });
      } else if (recorded.value.type === "failed") {
        logger.warn("document_review_run.table_run_failed", {
          entityId,
          "error.code": recorded.value.errorCode,
          workspaceId,
        });
      }
    }

    const isStillCurrentRequest = await isCurrentWorkflowRequest({
      requestId,
      workspaceId,
    });
    if (!isStillCurrentRequest) {
      return;
    }

    if (erroredProperties.length > 0) {
      await setFieldsStatus({
        workspaceId,
        entityVersionId,
        batch: { ...batch, properties: erroredProperties },
        contentType: "error",
        writeDb: actor.writeDb,
      });
    }

    const processedFields = {
      aiResults,
      aiJustifications,
      skippedPropertyIds,
      unsupportedPropertyIds,
    };

    // Write AI results to DB
    const candidatePropertyIds = [
      ...processedFields.aiResults.map((r) => r.propertyId),
      ...processedFields.unsupportedPropertyIds,
      ...processedFields.skippedPropertyIds,
    ];

    await actor.writeDb(async (tx) => {
      // Acquire per-cell advisory locks before re-checking lock state.
      // `SELECT FOR UPDATE` alone cannot block a manual edit that
      // inserts a brand-new `cell_metadata` row (READ COMMITTED takes
      // no gap lock); `acquireCellLocks` serializes with
      // `acquireCellLock` in lockCellOnManualEdit on a key derived
      // from (entityVersionId, propertyId), so we either see the new
      // lock here or the manual edit waits for our COMMIT.
      await acquireCellLocks({
        tx,
        entityVersionId,
        propertyIds: candidatePropertyIds,
      });
      const lockedRowsAtWrite =
        candidatePropertyIds.length > 0
          ? await tx
              .select({
                propertyId: cellMetadata.propertyId,
                metadata: cellMetadata.metadata,
              })
              .from(cellMetadata)
              .where(
                and(
                  eq(cellMetadata.entityVersionId, entityVersionId),
                  inArray(cellMetadata.propertyId, candidatePropertyIds),
                ),
              )
              .for("update")
          : [];
      const lockedAtWrite = new Set<string>();
      for (const row of lockedRowsAtWrite) {
        if (row.metadata.locked === true) {
          lockedAtWrite.add(row.propertyId);
        }
      }
      const allPropertyIds = candidatePropertyIds.filter(
        (id) => !lockedAtWrite.has(id),
      );

      if (allPropertyIds.length > 0) {
        await tx
          .delete(fields)
          .where(
            and(
              eq(fields.entityVersionId, entityVersionId),
              inArray(fields.propertyId, allPropertyIds),
            ),
          );
      }

      const fieldValues = [];
      for (const {
        fieldId,
        propertyId,
        content,
      } of processedFields.aiResults) {
        if (!lockedAtWrite.has(propertyId)) {
          fieldValues.push({
            id: fieldId,
            workspaceId,
            propertyId,
            entityVersionId,
            content,
          });
        }
      }
      for (const propertyId of processedFields.unsupportedPropertyIds) {
        if (!lockedAtWrite.has(propertyId)) {
          fieldValues.push({
            id: createSafeId<"field">(),
            workspaceId,
            propertyId,
            entityVersionId,
            content: { type: "unsupported" as const, version: 1 as const },
          });
        }
      }

      if (fieldValues.length > 0) {
        await tx.insert(fields).values(fieldValues);
      }

      if (processedFields.aiJustifications.length > 0) {
        const aiResultFieldIdsForLockedProps = new Set<string>();
        for (const { fieldId, propertyId } of processedFields.aiResults) {
          if (lockedAtWrite.has(propertyId)) {
            aiResultFieldIdsForLockedProps.add(fieldId);
          }
        }
        const liveJustifications = processedFields.aiJustifications.filter(
          (j) => !aiResultFieldIdsForLockedProps.has(j.fieldId),
        );
        if (liveJustifications.length > 0) {
          await tx.insert(justifications).values(
            liveJustifications.map((j) => ({
              id: j.justificationId,
              workspaceId,
              fieldId: j.fieldId,
              content: j.content,
              fileFieldIds: j.fileFieldIds,
            })),
          );
        }
      }
    });

    // Broadcast so the frontend shows updated fields.
    broadcastWorkspaceResourceSetUpdated(workspaceId, RESOURCE_TYPE.ENTITY);
  } finally {
    previewPublisher.clear();
  }
};

// ── Completion tracking ────────────────────────────────

type OnEntityCompletedArgs = {
  actor: WorkflowRunActor;
  extractionRuns: ExtractionRunStore;
  entityId: SafeId<"entity">;
  runLockTtlSec: number;
};

const onEntityCompleted = async ({
  actor,
  extractionRuns,
  entityId,
  runLockTtlSec,
}: OnEntityCompletedArgs) => {
  const { workspaceId, organizationId, runId: requestId } = actor;
  const runStateStore = getRootWorkflowRunStateStore();

  // Atomically re-check that this job still belongs to the active workflow
  // request AND record this entity's completion in the same Redis command
  // (see `COMPLETE_ENTITY_SCRIPT`). The check-and-write bundling closes the
  // stale-run window (a check could otherwise pass just before the run it
  // belongs to finishes); the SADD/SCARD set makes the write idempotent per
  // entity, so a re-driven entity (timeout after completion, stalled-job
  // reclaim, exhausted-retry failure handler) cannot double-count and push
  // the run to finalize while an entity is still mid-flight.
  const result = await runStateStore.recordEntityCompletion({
    entityId,
    requestId,
    runLockTtlSec,
    workspaceId,
  });
  if (!result.matched) {
    return;
  }

  await extractionRuns
    .syncProgress({
      completed: result.completed,
      id: requestId,
      organizationId,
      total: result.total,
      workspaceId,
    })
    .catch((error: unknown) => captureError(error, { workspaceId }));

  if (result.completed >= result.total) {
    await finishWorkflow(actor, extractionRuns);
    return;
  }

  // Long workflows can outlast the initial TTL. Refresh the request-bound
  // manifest with the lock and total; the completion set refreshes atomically
  // inside the completion script above.
  await runStateStore.refreshActiveLease({ runLockTtlSec, workspaceId });
};

// A starter a worker binds to its host's run store before handing it on, so
// the runs it starts cannot be recorded anywhere else.
type StartSuccessorWorkflow = (
  args: Omit<StartWorkflowArgs, "extractionRunStore">,
) => Promise<StartWorkflowResult>;

type MaybeRouteClassifiedDocumentsArgs = {
  actor: WorkflowRunActor;
  planPropertyIds: readonly SafeId<"property">[];
  startSuccessorWorkflow: StartSuccessorWorkflow;
};

// Route classified documents into `onClassified` playbooks, but only when the
// just-finished workflow actually computed the workspace's Document Type
// classifier (its id is in the plan). This is the recursion guard: a playbook
// run materializes ASK/verdict columns whose later completion must not re-route,
// and none of those columns is the classifier, so its id is absent from their
// plan and this short-circuits.
const maybeRouteClassifiedDocuments = async ({
  actor,
  planPropertyIds,
  startSuccessorWorkflow,
}: MaybeRouteClassifiedDocumentsArgs): Promise<void> => {
  if (planPropertyIds.length === 0) {
    return;
  }
  const classifier = await actor.inputDb(
    async (tx) => await resolveDocTypeClassifier(tx, actor.workspaceId),
  );
  if (
    !classifier ||
    !classifierParticipatedInPlan({
      classifierPropertyId: classifier.id,
      planPropertyIds,
    })
  ) {
    return;
  }

  await routeClassifiedDocuments({
    workspaceId: actor.workspaceId,
    organizationId: actor.organizationId,
    userId: actor.userId,
    scopedDb: actor.inputDb,
    startWorkflow: startSuccessorWorkflow,
    // Reuse the classifier already resolved above rather than having
    // resolveApplicablePlaybooks look it up a second time.
    classifier,
  });
};

/**
 * End the run as failed before finalization: its lock is released, and
 * nothing is freshened or started after it.
 */
const failRunBeforeFinalizing = async (
  actor: WorkflowRunActor,
  extractionRuns: ExtractionRunStore,
  errorCode: string,
): Promise<void> => {
  const { workspaceId } = actor;
  await extractionRuns
    .fail({
      id: actor.runId,
      organizationId: actor.organizationId,
      workspaceId,
      errorCode,
    })
    .catch((error: unknown) => captureError(error, { workspaceId }));
  await getRootWorkflowRunStateStore().clear(workspaceId);
  broadcastWorkflowStatus(workspaceId);
  broadcastWorkspaceResourceSetUpdated(workspaceId, RESOURCE_TYPE.PROPERTY);
};

const finishWorkflow = async (
  actor: WorkflowRunActor,
  extractionRuns: ExtractionRunStore,
) => {
  const { workspaceId, organizationId, runId: requestId } = actor;
  const isCurrentRequest = await isCurrentWorkflowRequest({
    requestId,
    workspaceId,
  });
  if (!isCurrentRequest) {
    return;
  }

  // Successor runs act for the same requester, so they start only while the
  // requester can still open the matter; each one's planning reads go through
  // `inputDb` again.
  if (!(await requesterCanOpenMatter(actor))) {
    await failRunBeforeFinalizing(
      actor,
      extractionRuns,
      INPUTS_UNAVAILABLE_ERROR_CODE,
    );
    return;
  }

  const runStateStore = getRootWorkflowRunStateStore();
  const startSuccessorWorkflow: StartSuccessorWorkflow = async (args) =>
    await startWorkflow({ ...args, extractionRunStore: extractionRuns });

  const finalizationResult = await runStateStore.readFinalizationState({
    requestId,
    workspaceId,
  });
  if (Result.isError(finalizationResult)) {
    // A transient Redis failure leaves the run intact so BullMQ can retry it.
    // It must never be reinterpreted as an empty or workspace-wide snapshot.
    captureError(finalizationResult.error, { workspaceId });
    throw finalizationResult.error;
  }
  const manifestResult = requireWorkflowFinalizationManifest({
    state: finalizationResult.value,
    workspaceId,
  });
  if (Result.isError(manifestResult)) {
    const invalidStateError = manifestResult.error;
    captureError(invalidStateError, { workspaceId });
    await failRunBeforeFinalizing(
      actor,
      extractionRuns,
      errorTag(invalidStateError),
    );
    return;
  }

  const manifest = manifestResult.value;
  // Scope gates freshening and nothing else. A cell-scoped run computed one
  // column for a few entities, so declaring that column workspace-wide fresh
  // would hide every cell it did not touch from the next sweep. What the
  // workspace still owes is read from durable state below, which a scoped run
  // narrows no more than any other.
  const wasScopedRun = manifest.freshnessScope === "cells";
  const { propertyIds: planPropertyIds, serviceTier } = manifest;

  if (!wasScopedRun) {
    // Freshen only the properties that were part of this workflow's
    // plan. Properties created mid-workflow are not in the snapshot —
    // they stay stale and trigger an automatic follow-up run below.
    try {
      await actor.writeDb(async (tx) => {
        await markPropertiesFresh({
          tx,
          workspaceId,
          propertyIds: planPropertyIds,
        });
      });
    } catch (error: unknown) {
      captureError(error, { workspaceId });
    }
  }

  await extractionRuns
    .complete({
      id: requestId,
      organizationId,
      workspaceId,
    })
    .catch((error: unknown) => captureError(error, { workspaceId }));

  // Clean up Redis state
  await runStateStore.clear(workspaceId);

  // Broadcast completion
  broadcastWorkflowStatus(workspaceId);
  broadcastWorkspaceResourceSetUpdated(workspaceId, RESOURCE_TYPE.PROPERTY);

  // Classification-driven routing. If this workflow (re)computed the Document
  // Type classifier, materialize + run any `onClassified` org playbooks now that
  // the run lock is released. Fire-and-forget with structured capture: a routing
  // failure must never fail (or block) the classification workflow. The
  // recursion guard inside — a playbook run's materialized columns are never the
  // classifier, so they cannot re-trigger routing — keeps this from looping.
  maybeRouteClassifiedDocuments({
    actor,
    planPropertyIds,
    startSuccessorWorkflow,
  }).catch((error: unknown) => captureError(error, { workspaceId }));

  // Grade whatever the workspace still owes: columns created mid-run, and the
  // columns of any start this run answered `already-running`. Unconditional by
  // design: a start deferred by a cell-scoped run has nothing else coming for
  // it (see `startStragglerCatchUp`).
  await startStragglerCatchUp({
    workspaceId,
    organizationId,
    userId: actor.userId,
    scopedDb: actor.inputDb,
    serviceTier,
    startWorkflow: startSuccessorWorkflow,
  });
};

// ── Helpers ────────────────────────────────────────────

type SetFieldsStatusArgs = {
  workspaceId: SafeId<"workspace">;
  entityVersionId: SafeId<"entityVersion">;
  batch: PropertyBatch;
  contentType: "pending" | "error" | "unsupported";
  writeDb: WorkflowRunActor["writeDb"];
};

const setFieldsStatus = async ({
  workspaceId,
  entityVersionId,
  batch,
  contentType,
  writeDb,
}: SetFieldsStatusArgs) => {
  const propertyIds = batch.properties.map((p) => p.id);

  await writeDb(async (tx) => {
    // Re-check locks under the per-cell advisory lock. The
    // lockedPropertyIds snapshot above (line ~1007) is taken
    // outside any lock, so a manual edit that lands between that
    // snapshot and this write would otherwise have its field value
    // clobbered by the `pending` placeholder before the final AI
    // write tx gets a chance to filter it out.
    await acquireCellLocks({ tx, entityVersionId, propertyIds });
    const lockedRows = await tx
      .select({
        propertyId: cellMetadata.propertyId,
        metadata: cellMetadata.metadata,
      })
      .from(cellMetadata)
      .where(
        and(
          eq(cellMetadata.entityVersionId, entityVersionId),
          inArray(cellMetadata.propertyId, propertyIds),
        ),
      );
    const lockedNow = new Set<string>();
    for (const row of lockedRows) {
      if (row.metadata.locked === true) {
        lockedNow.add(row.propertyId);
      }
    }
    const writablePropertyIds = propertyIds.filter((id) => !lockedNow.has(id));

    if (writablePropertyIds.length === 0) {
      return;
    }

    await tx
      .delete(fields)
      .where(
        and(
          eq(fields.entityVersionId, entityVersionId),
          inArray(fields.propertyId, writablePropertyIds),
        ),
      );

    const fieldValues = writablePropertyIds.map((propertyId) => ({
      id: createSafeId<"field">(),
      workspaceId,
      propertyId,
      entityVersionId,
      content: { type: contentType, version: 1 as const },
    }));

    await tx.insert(fields).values(fieldValues);
  });
};

const broadcastWorkflowStatus = (workspaceId: SafeId<"workspace">) => {
  broadcastWorkspaceResourceSetUpdated(workspaceId, RESOURCE_TYPE.FLOW_RUN);
};
