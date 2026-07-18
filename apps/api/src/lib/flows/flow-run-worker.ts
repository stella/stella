import { Worker } from "bullmq";
import { and, asc, gt, inArray } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { flowRuns } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { errorSystemFields, errorTag } from "@/api/lib/errors/utils";
import {
  executeFlowStep,
  failFlowRunFromWorker,
} from "@/api/lib/flows/flow-executor";
import {
  enqueueFlowStep,
  FLOW_RUN_QUEUE_NAME,
  type FlowStepJobData,
} from "@/api/lib/flows/flow-run-queue";
import { logger } from "@/api/lib/observability/logger";
import { createBullMqConnection } from "@/api/lib/redis-client";

// The BullMQ worker side of the flow-run engine. It lives in its own module so
// the executor can depend on the queue's `enqueueFlowStep` without a cycle: the
// executor imports the queue, and only this worker imports the executor.

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

// Batch size for the boot-time orphan re-enqueue scan. The scan keyset-paginates
// through every pending/running run rather than stopping at the first batch, so a
// backlog larger than one batch is still fully recovered.
const ORPHAN_SCAN_BATCH_SIZE = 1000;

/**
 * Initialize the BullMQ worker for flow runs. Call once at API startup
 * (mirrors `initWorkflowWorker`). The worker owns a dedicated blocking Redis
 * connection.
 */
export const initFlowRunWorker = (): Worker<FlowStepJobData> => {
  const workerConnection = createBullMqConnection();

  const worker = new Worker<FlowStepJobData>(
    FLOW_RUN_QUEUE_NAME,
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

// Keyset-paginate by id through every `pending`/`running` run and re-enqueue its
// current step. Re-adding the step does not change the row's status, so a plain
// `LIMIT` scan would re-select the same head of the backlog on every restart and
// never reach the tail; ordering by id and advancing a cursor visits each run
// exactly once until the backlog is drained. `batchSize` is injectable so tests
// can exercise the multi-batch path without seeding thousands of rows.
export const reconcileOrphanedFlowRuns = async (
  batchSize: number = ORPHAN_SCAN_BATCH_SIZE,
): Promise<void> => {
  let cursor: SafeId<"flowRun"> | null = null;
  let reconciled = 0;

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- keyset pages are inherently sequential: each query needs the previous batch's last id as its cursor
    const batch = await rootDb
      .select({
        id: flowRuns.id,
        currentStepIndex: flowRuns.currentStepIndex,
      })
      .from(flowRuns)
      .where(
        and(
          inArray(flowRuns.status, ["pending", "running"]),
          cursor === null ? undefined : gt(flowRuns.id, cursor),
        ),
      )
      .orderBy(asc(flowRuns.id))
      .limit(batchSize);

    if (batch.length === 0) {
      break;
    }

    for (const row of batch) {
      // oxlint-disable-next-line no-await-in-loop -- sequential re-enqueue bounds concurrent queue writes; the batch is capped at batchSize
      await enqueueFlowStep({ runId: row.id, stepIndex: row.currentStepIndex });
    }

    reconciled += batch.length;

    const lastRow = batch.at(-1);
    if (lastRow === undefined || batch.length < batchSize) {
      break;
    }
    cursor = lastRow.id;
  }

  if (reconciled > 0) {
    logger.info("flow.orphans_reconciled", { count: String(reconciled) });
  }
};
