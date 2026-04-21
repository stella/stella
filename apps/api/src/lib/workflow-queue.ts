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
import type { SafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import {
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

const workflowKey = (workspaceId: string, field: string) =>
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
  redisClient ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return redisClient;
};

const getQueue = (): Queue => {
  queue ??= new Queue(QUEUE_NAME, {
    connection: getRedis(),
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
  return queue;
};

/**
 * Check if a workflow is currently running for a workspace.
 */
export const isWorkflowRunning = async (
  workspaceId: string,
): Promise<boolean> => {
  const val = await getRedis().get(workflowKey(workspaceId, "running"));
  return val === "1";
};

type StartWorkflowArgs = {
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  scopedDb: ScopedDb;
  entityIds?: string[];
  entityIdsOrder?: string[];
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

  // Check if already running (atomic check-and-set).
  // 2-hour TTL self-heals if the process crashes before finishWorkflow.
  const wasSet = await redis.set(
    workflowKey(workspaceId, "running"),
    "1",
    "EX",
    7200,
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

    const requestId = crypto.randomUUID();

    // Store entity count for completion tracking
    await redis.set(
      workflowKey(workspaceId, "total"),
      String(orderedEntityIds.length),
    );
    await redis.set(workflowKey(workspaceId, "completed"), "0");

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
    maxRetriesPerRequest: null,
  });

  const worker = new Worker<EntityJobData>(
    QUEUE_NAME,
    async (job) => {
      await processEntityJob(job.data);
    },
    {
      connection: workerConnection,
      concurrency: MAX_CONCURRENT_ENTITIES,
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
            entityId,
            batch,
            level,
            scopedDb,
            requestId,
          }),
      ),
    );
  }

  // Broadcast entity invalidation so frontend refetches
  broadcastInvalidation(workspaceId, ["entities", workspaceId]);

  await onEntityCompleted(branded.workspaceId, branded.organizationId, userId);
};

type ProcessOneBatchArgs = {
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  entityId: string;
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
      where: { id: entityId },
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

  const fieldContentMap = new Map<string, FieldContent["type"]>(
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
        id: crypto.randomUUID(),
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
          htmlVersion: j.htmlVersion,
          htmlContent: j.htmlContent,
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

  try {
    const scopedDb = createRootScopedDb({
      organizationId,
      userId,
      workspaceIds: [workspaceId],
    });

    await scopedDb((tx) =>
      tx
        .update(properties)
        .set({ status: "fresh" })
        .where(eq(properties.workspaceId, workspaceId)),
    );
  } catch (error: unknown) {
    captureError(error, { workspaceId });
  }

  // Clean up Redis state
  await redis.del(
    workflowKey(workspaceId, "running"),
    workflowKey(workspaceId, "total"),
    workflowKey(workspaceId, "completed"),
  );

  // Broadcast completion
  broadcastWorkflowStatus(workspaceId, false);
  broadcastInvalidation(workspaceId, ["properties", workspaceId]);
};

// ── Helpers ────────────────────────────────────────────

type SetFieldsStatusArgs = {
  workspaceId: SafeId<"workspace">;
  entityVersionId: string;
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
      id: crypto.randomUUID(),
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

const broadcastWorkflowStatus = (workspaceId: string, running: boolean) => {
  broadcastInvalidation(workspaceId, ["workspaces", workspaceId, "workflow"]);
  if (!running) {
    broadcastInvalidation(workspaceId, ["entities", workspaceId]);
  }
};

const broadcastInvalidation = (
  workspaceId: string,
  queryKey: readonly string[],
) => {
  broadcast(workspaceId, { type: "invalidate-query", data: queryKey });
};
