import { Result } from "better-result";
import { Queue, Worker } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";
import Redis from "ioredis";

import { isMockAI } from "@/api/consts";
import type { ScopedDb } from "@/api/db";
import { jsonField } from "@/api/db/json-utils";
import { entities, fields, justifications, properties } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { env } from "@/api/env";
import { loadOrgAIConfig } from "@/api/lib/ai-config-cache";
import { captureError } from "@/api/lib/analytics";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";
import { redisConnectionOptions } from "@/api/lib/redis-options";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import {
  brandPersistedEntityId,
  brandPersistedPropertyId,
  brandPersistedUserId,
  brandValidatedWorkflowActorKey,
} from "@/api/lib/safe-id-boundaries";
import { broadcast } from "@/api/lib/sse";
import { generateBatch } from "@/api/lib/workflow/generate-batch";
import { generateBatchMock } from "@/api/lib/workflow/generate-batch-mock";
import type {
  ExecutionLevel,
  PropertyBatch,
} from "@/api/lib/workflow/get-execution-plan";
import {
  getExecutionPlanData,
  getPropertyExecutionPlan,
} from "@/api/lib/workflow/get-execution-plan";
import { prepareBatch } from "@/api/lib/workflow/utils";

// ── Redis keys ─────────────────────────────────────────
const WORKFLOW_KEY_PREFIX = "workflow";

const workflowKey = (workspaceId: SafeId<"workspace">, field: string) =>
  `${WORKFLOW_KEY_PREFIX}:${workspaceId}:${field}`;

// ── Queue name ─────────────────────────────────────────
const QUEUE_NAME = "workflow";

// ── Entity processing ──────────────────────────────────

const MAX_CONCURRENT_ENTITIES = 10;

type EntityJobData = {
  workspaceId: string;
  organizationId: string;
  userId: string;
  entityId: string;
  executionPlan: ExecutionLevel[];
  requestId: string;
};

// ── Public API ─────────────────────────────────────────

let queue: Queue | null = null;
let redisClient: Redis | null = null;

const getRedis = (): Redis => {
  redisClient ??= new Redis(env.REDIS_URL, {
    ...redisConnectionOptions(),
    maxRetriesPerRequest: null,
  });
  return redisClient;
};

const getQueue = (): Queue => {
  queue ??= new Queue(QUEUE_NAME, {
    connection: getRedis(),
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 500,
      // Retry once with backoff so a single transient failure (network
      // blip, AI provider 5xx) doesn't leave the cell empty. Stays low
      // enough that genuine logic errors surface quickly.
      attempts: 2,
      backoff: { type: "exponential", delay: 5000 },
    },
  });
  return queue;
};

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
// JOB_HARD_TIMEOUT_MS: process-level wrapper so a hung AI call can't
// keep a job "active" forever. Slightly longer than LOCK_DURATION_MS
// to let BullMQ's stalled detection fire first when applicable.
const LOCK_DURATION_MS = 5 * 60 * 1000;
const STALLED_INTERVAL_MS = 30 * 1000;
const MAX_STALLED_COUNT = 2;
const JOB_HARD_TIMEOUT_MS = 6 * 60 * 1000;
const RUNNING_LOCK_TTL_SEC = 15 * 60;

/**
 * Check if a workflow is currently running for a workspace.
 */
export const isWorkflowRunning = async (
  workspaceId: SafeId<"workspace">,
): Promise<boolean> => {
  const val = await getRedis().get(workflowKey(workspaceId, "running"));
  return val === "1";
};

type StartWorkflowArgs = {
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  scopedDb: ScopedDb;
  entityIds?: SafeId<"entity">[];
  entityIdsOrder?: SafeId<"entity">[];
};

type StartWorkflowResult = {
  status: "started" | "already-running" | "skipped" | "failed";
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
}: StartWorkflowArgs): Promise<StartWorkflowResult> => {
  const redis = getRedis();

  // Check if already running (atomic check-and-set). The TTL is the
  // safety net for an uncleanly-killed worker; tuned tight enough that
  // a recovered workspace doesn't sit blocked for hours.
  const wasSet = await redis.set(
    workflowKey(workspaceId, "running"),
    "1",
    "EX",
    RUNNING_LOCK_TTL_SEC,
    "NX",
  );
  if (!wasSet) {
    return { status: "already-running" };
  }

  try {
    const executionPlanData = await getExecutionPlanData(workspaceId, scopedDb);
    const executionPlan = getPropertyExecutionPlan(executionPlanData);

    const hasWork = executionPlan.some((level) =>
      level.some((batch) => batch.properties.length > 0),
    );

    if (!hasWork) {
      await redis.del(workflowKey(workspaceId, "running"));
      return { status: "skipped" };
    }

    // Get all non-folder entities
    const entityRows = await scopedDb((tx) =>
      tx
        .select({ id: entities.id, kind: entities.kind })
        .from(entities)
        .where(eq(entities.workspaceId, workspaceId)),
    );

    const nonFolderIds = new Set(
      entityRows.filter((e) => e.kind !== "folder").map((e) => e.id),
    );

    const targetIds =
      inputEntityIds && inputEntityIds.length > 0
        ? inputEntityIds.filter((id) => nonFolderIds.has(id))
        : [...nonFolderIds];

    // Prioritize entities from entityIdsOrder first
    const targetSet = new Set(targetIds);
    const prioritized = (inputOrder ?? []).filter((id) => targetSet.has(id));
    const prioritizedSet = new Set(prioritized);
    const remaining = targetIds.filter((id) => !prioritizedSet.has(id));
    const orderedEntityIds = [...prioritized, ...remaining];

    if (orderedEntityIds.length === 0) {
      await redis.del(workflowKey(workspaceId, "running"));
      return { status: "skipped" };
    }

    const requestId = Bun.randomUUIDv7();

    // Store entity count for completion tracking
    await redis.set(
      workflowKey(workspaceId, "total"),
      String(orderedEntityIds.length),
    );
    await redis.set(workflowKey(workspaceId, "completed"), "0");

    // Snapshot the property IDs in this workflow's plan so finishWorkflow
    // can freshen only the ones it actually processed. Without this,
    // properties created mid-workflow get marked fresh without ever
    // running, leaving cells permanently empty.
    const planPropertyIds = executionPlan.flatMap((level) =>
      level.flatMap((batch) => batch.properties.map((p) => p.id)),
    );
    await redis.set(
      workflowKey(workspaceId, "plan-properties"),
      JSON.stringify(planPropertyIds),
      "EX",
      RUNNING_LOCK_TTL_SEC,
    );

    // Broadcast running status
    broadcastWorkflowStatus(workspaceId, true);

    // Enqueue one job per entity
    const q = getQueue();
    await q.addBulk(
      orderedEntityIds.map((entityId) => ({
        name: "process-entity",
        data: {
          workspaceId,
          organizationId,
          userId,
          entityId,
          executionPlan,
          requestId,
        } satisfies EntityJobData,
      })),
    );

    return { status: "started" };
  } catch (error: unknown) {
    await redis.del(workflowKey(workspaceId, "running"));
    broadcastWorkflowStatus(workspaceId, false);
    captureError(error, { workspaceId });
    return { status: "failed" };
  }
};

// ── Worker ─────────────────────────────────────────────

/**
 * Initialize the BullMQ worker. Call once at API startup.
 */
export const initWorkflowWorker = () => {
  // BullMQ Worker uses blocking commands (BRPOPLPUSH) so it
  // needs a dedicated Redis connection, not the shared one.
  const workerConnection = new Redis(env.REDIS_URL, {
    ...redisConnectionOptions(),
    maxRetriesPerRequest: null,
  });

  const worker = new Worker<EntityJobData>(
    QUEUE_NAME,
    async (job) => {
      // Hard process-level timeout. A hung AI provider, a runaway
      // batch, or a broken external call would otherwise keep the job
      // "active" indefinitely and block follow-up workflow runs.
      // Throwing here flips it to "failed" → BullMQ retries (attempts: 2)
      // → finally counts as completed by the failed-handler so the
      // workspace lock can release.
      await Promise.race([
        processEntityJob(job.data),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(
              new Error(
                `workflow.job_timeout: entity ${job.data.entityId} exceeded ${JOB_HARD_TIMEOUT_MS}ms`,
              ),
            );
          }, JOB_HARD_TIMEOUT_MS);
        }),
      ]);
    },
    {
      connection: workerConnection,
      concurrency: MAX_CONCURRENT_ENTITIES,
      // Lock-extension lets BullMQ's stalled-job detector evict a
      // crashed worker's jobs back onto the queue.
      lockDuration: LOCK_DURATION_MS,
      stalledInterval: STALLED_INTERVAL_MS,
      maxStalledCount: MAX_STALLED_COUNT,
    },
  );

  worker.on("failed", (job, error) => {
    if (!job) {
      return;
    }
    const data = job.data;
    logger.error("workflow.entity_failed", {
      workspaceId: data.workspaceId,
      entityId: data.entityId,
      error: String(error),
    });

    // Still increment completed counter so workflow can finish
    const branded = brandValidatedWorkflowActorKey({
      organizationId: data.organizationId,
      workspaceId: data.workspaceId,
    });
    void onEntityCompleted(
      branded.workspaceId,
      branded.organizationId,
      brandPersistedUserId(data.userId),
    );
  });

  worker.on("error", (error) => {
    logger.error("workflow.worker_error", { error: String(error) });
  });

  logger.info("workflow.worker_started", {
    concurrency: String(MAX_CONCURRENT_ENTITIES),
  });

  return worker;
};

// ── Entity processing ──────────────────────────────────

const processEntityJob = async (data: EntityJobData) => {
  const {
    workspaceId,
    organizationId,
    userId: rawUserId,
    entityId,
    executionPlan,
    requestId,
  } = data;

  // Brand IDs at the boundary — job data stores plain strings (JSON).
  const branded = brandValidatedWorkflowActorKey({
    organizationId,
    workspaceId,
  });
  const userId = brandPersistedUserId(rawUserId);
  const brandedEntityId = brandPersistedEntityId(entityId);

  const scopedDb = createRootScopedDb({
    organizationId: branded.organizationId,
    userId,
    workspaceIds: [branded.workspaceId],
  });

  for (let level = 0; level < executionPlan.length; level++) {
    const batches = executionPlan[level];
    if (!batches || batches.length === 0) {
      continue;
    }

    // Process all batches at this level in parallel
    // (same level = independent dependencies)
    await Promise.all(
      batches.map(
        async (batch) =>
          await processOneBatch({
            workspaceId: branded.workspaceId,
            organizationId: branded.organizationId,
            entityId: brandedEntityId,
            batch,
            level,
            scopedDb,
            requestId,
          }),
      ),
    );
  }

  // Broadcast entity invalidation so frontend refetches
  broadcastInvalidation(branded.workspaceId, ["entities", branded.workspaceId]);

  await onEntityCompleted(branded.workspaceId, branded.organizationId, userId);
};

type ProcessOneBatchArgs = {
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  entityId: SafeId<"entity">;
  batch: PropertyBatch;
  level: number;
  scopedDb: ScopedDb;
  requestId: string;
};

const processOneBatch = async ({
  workspaceId,
  organizationId,
  entityId,
  batch: rawBatch,
  level,
  scopedDb,
  requestId,
}: ProcessOneBatchArgs) => {
  const entityRow = await scopedDb((tx) =>
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
  const batchFields = await scopedDb((tx) =>
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

  const batch = prepareBatch(rawBatch, fieldContentMap);

  if (batch.properties.length === 0) {
    return;
  }

  // Set fields to "pending"
  await setFieldsStatus({
    workspaceId,
    entityVersionId,
    batch,
    contentType: "pending",
    scopedDb,
  });

  // Broadcast so frontend shows pending state
  broadcastInvalidation(workspaceId, ["entities", workspaceId]);

  const orgAIConfig = await loadOrgAIConfig(organizationId);
  const generateFn = isMockAI() ? generateBatchMock : generateBatch;

  // generateBatch returns a Result<T, E> directly
  const batchResult = await generateFn({
    abortSignal: AbortSignal.timeout(120_000),
    batch,
    entityVersionId,
    organizationId,
    workspaceId,
    scopedDb,
    orgAIConfig,
  });

  if (Result.isError(batchResult)) {
    captureError(batchResult.error, {
      workspaceId,
      entityId,
      batchId: batch.id,
      level: String(level),
      requestId,
    });

    await setFieldsStatus({
      workspaceId,
      entityVersionId,
      batch,
      contentType: "error",
      scopedDb,
    });
    return;
  }

  const processedFields = batchResult.value;

  // Write AI results to DB
  const allPropertyIds = [
    ...processedFields.aiResults.map((r) => r.propertyId),
    ...processedFields.unsupportedPropertyIds,
    ...processedFields.skippedPropertyIds,
  ];

  await scopedDb(async (tx) => {
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

    const fieldValues = [
      ...processedFields.aiResults.map(({ fieldId, propertyId, content }) => ({
        id: fieldId,
        workspaceId,
        propertyId,
        entityVersionId,
        content,
      })),
      ...processedFields.unsupportedPropertyIds.map((propertyId) => ({
        id: createSafeId<"field">(),
        workspaceId,
        propertyId,
        entityVersionId,
        content: { type: "unsupported" as const, version: 1 as const },
      })),
    ];

    if (fieldValues.length > 0) {
      await tx.insert(fields).values(fieldValues);
    }

    if (processedFields.aiJustifications.length > 0) {
      await tx.insert(justifications).values(
        processedFields.aiJustifications.map((j) => ({
          id: j.justificationId,
          workspaceId,
          fieldId: j.fieldId,
          content: j.content,
          fileFieldIds: j.fileFieldIds,
        })),
      );
    }
  });

  // Broadcast so frontend shows updated fields
  broadcastInvalidation(workspaceId, ["entities", workspaceId]);
};

// ── Completion tracking ────────────────────────────────

const onEntityCompleted = async (
  workspaceId: SafeId<"workspace">,
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
) => {
  const redis = getRedis();
  const completed = await redis.incr(workflowKey(workspaceId, "completed"));
  const totalStr = await redis.get(workflowKey(workspaceId, "total"));
  const total = Number(totalStr ?? "0");

  if (completed >= total) {
    await finishWorkflow(workspaceId, organizationId, userId);
  }
};

const finishWorkflow = async (
  workspaceId: SafeId<"workspace">,
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
) => {
  const redis = getRedis();
  const scopedDb = createRootScopedDb({
    organizationId,
    userId,
    workspaceIds: [workspaceId],
  });

  // Freshen only the properties that were part of this workflow's plan.
  // Properties created mid-workflow are not in the snapshot — they stay
  // stale and trigger an automatic follow-up run below.
  let processedIds: SafeId<"property">[] = [];
  try {
    const planRaw = await redis.get(
      workflowKey(workspaceId, "plan-properties"),
    );
    if (planRaw !== null) {
      const parsed: unknown = JSON.parse(planRaw);
      if (Array.isArray(parsed)) {
        processedIds = parsed
          .filter((value): value is string => typeof value === "string")
          .map((value) => brandPersistedPropertyId(value));
      }
    }

    if (processedIds.length > 0) {
      await scopedDb((tx) =>
        tx
          .update(properties)
          .set({ status: "fresh" })
          .where(
            and(
              eq(properties.workspaceId, workspaceId),
              inArray(properties.id, processedIds),
            ),
          ),
      );
    } else {
      // Backwards-compat: pre-snapshot workflows had no plan recorded.
      // Behave as before so they still finalize.
      await scopedDb((tx) =>
        tx
          .update(properties)
          .set({ status: "fresh" })
          .where(eq(properties.workspaceId, workspaceId)),
      );
    }
  } catch (error: unknown) {
    captureError(error, { workspaceId });
  }

  // Clean up Redis state
  await redis.del(
    workflowKey(workspaceId, "running"),
    workflowKey(workspaceId, "total"),
    workflowKey(workspaceId, "completed"),
    workflowKey(workspaceId, "plan-properties"),
  );

  // Broadcast completion
  broadcastWorkflowStatus(workspaceId, false);
  broadcastInvalidation(workspaceId, ["properties", workspaceId]);

  // Catch up on any properties created mid-workflow. They were left
  // stale by the partial freshen above; kick off a follow-up run so
  // their cells get populated without the user having to nudge again.
  try {
    const stragglers = await scopedDb((tx) =>
      tx
        .select({ id: properties.id })
        .from(properties)
        .where(
          and(
            eq(properties.workspaceId, workspaceId),
            eq(properties.status, "stale"),
          ),
        )
        .limit(1),
    );
    if (stragglers.length > 0) {
      void startWorkflow({
        workspaceId,
        organizationId,
        userId,
        scopedDb,
      }).catch((error: unknown) => captureError(error, { workspaceId }));
    }
  } catch (error: unknown) {
    captureError(error, { workspaceId });
  }
};

// ── Helpers ────────────────────────────────────────────

type SetFieldsStatusArgs = {
  workspaceId: SafeId<"workspace">;
  entityVersionId: SafeId<"entityVersion">;
  batch: PropertyBatch;
  contentType: "pending" | "error" | "unsupported";
  scopedDb: ScopedDb;
};

const setFieldsStatus = async ({
  workspaceId,
  entityVersionId,
  batch,
  contentType,
  scopedDb,
}: SetFieldsStatusArgs) => {
  const propertyIds = batch.properties.map((p) => p.id);

  await scopedDb(async (tx) => {
    await tx
      .delete(fields)
      .where(
        and(
          eq(fields.entityVersionId, entityVersionId),
          inArray(fields.propertyId, propertyIds),
        ),
      );

    const fieldValues = propertyIds.map((propertyId) => ({
      id: createSafeId<"field">(),
      workspaceId,
      propertyId,
      entityVersionId,
      content: { type: contentType, version: 1 as const },
    }));

    if (fieldValues.length > 0) {
      await tx.insert(fields).values(fieldValues);
    }
  });
};

const broadcastWorkflowStatus = (
  workspaceId: SafeId<"workspace">,
  running: boolean,
) => {
  broadcastInvalidation(workspaceId, ["workspaces", workspaceId, "workflow"]);
  if (!running) {
    broadcastInvalidation(workspaceId, ["entities", workspaceId]);
  }
};

const broadcastInvalidation = (
  workspaceId: SafeId<"workspace">,
  queryKey: readonly string[],
) => {
  broadcast(workspaceId, { type: "invalidate-query", data: queryKey });
};
