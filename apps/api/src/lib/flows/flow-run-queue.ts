import { Queue, Worker } from "bullmq";
import { inArray } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { flowRuns } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { errorSystemFields, errorTag } from "@/api/lib/errors/utils";
import {
  executeFlowStep,
  failFlowRunFromWorker,
} from "@/api/lib/flows/flow-executor";
import { logger } from "@/api/lib/observability/logger";
import { createBullMqConnection } from "@/api/lib/redis-client";

// ── Queue name + payload ────────────────────────────────

const QUEUE_NAME = "flow-run";

/**
 * One queued unit of flow-run work: execute a single step of one run. The
 * payload is intentionally minimal — the run row is the source of truth for
 * everything else (snapshot, status, inputs), so a stale job can never carry
 * outdated definition state.
 */
export type FlowStepJobData = {
  runId: string;
  stepIndex: number;
};

// ── Retry / self-heal levers ────────────────────────────
//
// Modeled on the extraction engine (`workflow-queue.ts`): retry once on a
// transient failure (network blip, AI provider 5xx) with exponential backoff,
// but keep attempts low so a genuine logic error surfaces quickly. Only the
// final attempt flips the run to `failed` (see the worker `failed` handler).

const FLOW_STEP_JOB_ATTEMPTS = 2;
const FLOW_STEP_JOB_BACKOFF_MS = 5_000;
const FLOW_STEP_JOB_CONCURRENCY = 5;

// An `ai` step is the slow case; give the worker lock enough headroom to
// outlast one generation, while the stalled-job detector still reclaims a
// crashed worker's jobs.
const LOCK_DURATION_MS = 5 * 60 * 1000;
const STALLED_INTERVAL_MS = 30 * 1000;
const MAX_STALLED_COUNT = 2;

// Process-level ceiling per step job. Pipes an AbortSignal into the executor so
// the timeout actually cancels the in-flight AI request instead of leaving a
// hung job "active" and blocking follow-up steps.
const FLOW_STEP_JOB_TIMEOUT_MS = 4 * 60 * 1000;

// Upper bound on the boot-time orphan re-enqueue scan.
const ORPHAN_SCAN_LIMIT = 1_000;

// ── Lazy singletons ─────────────────────────────────────

let queue: Queue<FlowStepJobData> | null = null;
let queueConnection: ReturnType<typeof createBullMqConnection> | null = null;

const getQueueConnection = () => {
  queueConnection ??= createBullMqConnection();
  return queueConnection;
};

const getQueue = (): Queue<FlowStepJobData> => {
  queue ??= new Queue<FlowStepJobData>(QUEUE_NAME, {
    connection: getQueueConnection(),
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 500,
      attempts: FLOW_STEP_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: FLOW_STEP_JOB_BACKOFF_MS },
    },
  });
  return queue;
};

// Deterministic per-(run, step) job id. Prevents the same step being enqueued
// twice (start + orphan sweep, or two concurrent review resolutions) and lets
// the boot reconciler re-add a step idempotently.
const flowStepJobId = (runId: string, stepIndex: number): string =>
  `flow-run-${runId}-${stepIndex}`;

/**
 * Enqueue one step of a run. Called by `startFlowRun` (step 0), by the
 * executor when advancing to the next step, and by `resolveFlowReviewGate`
 * when a gate is approved. `delayMs` (file-upload trigger only) defers step 0
 * so async extraction can populate `extractedContent` first; the job data stays
 * minimal ({runId, stepIndex}) so a stale job can never carry outdated state.
 */
export type EnqueueFlowStepOptions = FlowStepJobData & { delayMs?: number };

export const enqueueFlowStep = async ({
  runId,
  stepIndex,
  delayMs,
}: EnqueueFlowStepOptions): Promise<void> => {
  await getQueue().add(
    "flow-step",
    { runId, stepIndex },
    {
      jobId: flowStepJobId(runId, stepIndex),
      ...(delayMs !== undefined && { delay: delayMs }),
    },
  );
};

// ── Worker ──────────────────────────────────────────────

/**
 * Initialize the BullMQ worker for flow runs. Call once at API startup
 * (mirrors `initWorkflowWorker`). The worker owns a dedicated blocking Redis
 * connection.
 */
export const initFlowRunWorker = (): Worker<FlowStepJobData> => {
  const workerConnection = createBullMqConnection();

  const worker = new Worker<FlowStepJobData>(
    QUEUE_NAME,
    async (job) => {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => {
        controller.abort(
          new Error(
            `flow.step_timeout: run ${job.data.runId} step ${String(job.data.stepIndex)} exceeded ${FLOW_STEP_JOB_TIMEOUT_MS}ms`,
          ),
        );
      }, FLOW_STEP_JOB_TIMEOUT_MS);
      try {
        await executeFlowStep(job.data, controller.signal);
        // Surface a late abort so BullMQ marks the attempt failed rather than
        // completed if the signal fired after the last awaited call.
        controller.signal.throwIfAborted();
      } finally {
        clearTimeout(timeoutHandle);
      }
    },
    {
      connection: workerConnection,
      concurrency: FLOW_STEP_JOB_CONCURRENCY,
      lockDuration: LOCK_DURATION_MS,
      stalledInterval: STALLED_INTERVAL_MS,
      maxStalledCount: MAX_STALLED_COUNT,
    },
  );

  worker.on("failed", (job, error) => {
    if (!job) {
      return;
    }
    logger.error("flow.step_failed", {
      runId: job.data.runId,
      stepIndex: String(job.data.stepIndex),
      attemptsMade: String(job.attemptsMade),
      "error.type": errorTag(error),
    });

    // With retries enabled the failed event also fires for a transient first
    // attempt; only flip the run to `failed` once BullMQ has exhausted its
    // attempts, otherwise a retry would run against an already-failed run.
    const totalAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < totalAttempts) {
      return;
    }

    void failFlowRunFromWorker(job.data, error).catch(
      (finalizeError: unknown) => {
        captureError(finalizeError, {
          runId: job.data.runId,
          stepIndex: String(job.data.stepIndex),
        });
      },
    );
  });

  worker.on("error", (error) => {
    logger.error("flow.worker_error", errorSystemFields(error));
  });

  logger.info("flow.worker_started", {
    concurrency: String(FLOW_STEP_JOB_CONCURRENCY),
  });

  // Re-enqueue steps a previously-killed worker left mid-flight. A run in
  // `pending`/`running` whose step job was lost (hard kill, OOM, deploy
  // SIGTERM) would otherwise hang forever. Re-adding the current step is
  // idempotent: the deterministic job id no-ops a still-live job, and the
  // executor guards against re-running an already-completed step.
  // `awaiting_review` runs are intentionally parked on a human, not orphans.
  void reconcileOrphanedFlowRuns().catch((error: unknown) => {
    captureError(error);
    logger.error("flow.reconcile_failed", errorSystemFields(error));
  });

  return worker;
};

const reconcileOrphanedFlowRuns = async (): Promise<void> => {
  const rows = await rootDb
    .select({
      id: flowRuns.id,
      currentStepIndex: flowRuns.currentStepIndex,
    })
    .from(flowRuns)
    .where(inArray(flowRuns.status, ["pending", "running"]))
    .limit(ORPHAN_SCAN_LIMIT);

  if (rows.length === 0) {
    return;
  }

  for (const row of rows) {
    // oxlint-disable-next-line no-await-in-loop -- sequential re-enqueue bounds concurrent queue writes; the set is capped at ORPHAN_SCAN_LIMIT
    await enqueueFlowStep({ runId: row.id, stepIndex: row.currentStepIndex });
  }

  logger.info("flow.orphans_reconciled", { count: String(rows.length) });
};
