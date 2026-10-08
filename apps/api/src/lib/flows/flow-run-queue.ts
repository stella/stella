import type { Queue, JobsOptions } from "bullmq";

import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";

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

export const FLOW_STEP_JOB_OPTIONS = {
  // Paused admission completes the queue attempt; the durable run must be re-enqueueable on regrant.
  removeOnComplete: true,
  removeOnFail: 500,
  attempts: FLOW_STEP_JOB_ATTEMPTS,
  backoff: { type: "exponential", delay: FLOW_STEP_JOB_BACKOFF_MS },
} as const satisfies JobsOptions;

const getQueue = createLazyBullMqQueue<FlowStepJobData>({
  name: FLOW_RUN_QUEUE_NAME,
  defaultJobOptions: FLOW_STEP_JOB_OPTIONS,
});

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

type EnqueueFlowStepDependencies = {
  queue: Pick<Queue<FlowStepJobData>, "add">;
};

export const enqueueFlowStep = async (
  { runId, stepIndex, delayMs }: EnqueueFlowStepOptions,
  dependencies?: EnqueueFlowStepDependencies,
): Promise<void> => {
  const queue = dependencies?.queue ?? getQueue();
  await queue.add(
    "flow-step",
    { runId, stepIndex },
    {
      jobId: flowStepJobId(runId, stepIndex),
      ...(delayMs !== undefined && { delay: delayMs }),
    },
  );
};
