import { Queue } from "bullmq";

import { createBullMqConnection } from "@/api/lib/redis-client";

// ── Queue name + payload ────────────────────────────────

/** BullMQ queue name shared by the enqueue side (here) and the worker. */
export const FLOW_RUN_QUEUE_NAME = "flow-run";

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
const FLOW_STEP_JOB_BACKOFF_MS = 5000;

// ── Lazy singletons ─────────────────────────────────────

let queue: Queue<FlowStepJobData> | null = null;
let queueConnection: ReturnType<typeof createBullMqConnection> | null = null;

const getQueueConnection = () => {
  queueConnection ??= createBullMqConnection();
  return queueConnection;
};

const getQueue = (): Queue<FlowStepJobData> => {
  queue ??= new Queue<FlowStepJobData>(FLOW_RUN_QUEUE_NAME, {
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
