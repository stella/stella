import { panic } from "better-result";
import type {
  FinishedStatus,
  JobState,
  JobsOptions,
  RetryOptions,
} from "bullmq";

import { withTimeout } from "@/api/lib/with-timeout";

/**
 * Deadline on one queue command.
 *
 * The client does not time these out on its own, so a broker that accepts the
 * connection and then stops answering leaves every command pending. A sweep
 * runs many of them, and its scheduler lease is measured in minutes: without a
 * bound the whole tick would sit on the first unanswered command and be killed
 * with nothing recorded. Failing fast instead makes the stall a captured error
 * per row, and the next tick retries.
 */
const QUEUE_OPERATION_TIMEOUT_MS = 2000;

/**
 * What one re-enqueue did. `queue-owned` is a healthy outcome rather than a
 * skipped one: a live job is already driving the row, so a sweep that counted
 * it as recovered work would report a backlog it never had.
 */
export const QUEUE_REQUEUE_OUTCOME = {
  QUEUE_OWNED: "queue-owned",
  REQUEUED: "requeued",
} as const;

export type QueueRequeueOutcome =
  (typeof QUEUE_REQUEUE_OUTCOME)[keyof typeof QUEUE_REQUEUE_OUTCOME];

/** `getState` answers `unknown` for an id the queue no longer holds. */
type ExistingJobState = JobState | "unknown";

/**
 * What a job already holding the id means for the re-enqueue:
 *   - `owned`: a live job is the enqueue this call would otherwise duplicate.
 *   - `retry`: a failed job reruns under its own id and data, with a fresh
 *     attempt budget, so a queue with backoff retries it the way it would a new
 *     job. A retry starts at once, so a requeue that asks for a delay replaces
 *     the failed job instead (remove, then add with the delay).
 *   - `reclaim`: a completed job is kept history, not work; it is removed
 *     so the `add` that follows is not ignored as a duplicate id.
 *   - `add`: the id was released between the lookup and the state read.
 */
type ExistingJobAction = "add" | "owned" | "reclaim" | "retry";

const EXISTING_JOB_ACTION = {
  active: "owned",
  completed: "reclaim",
  delayed: "owned",
  failed: "retry",
  prioritized: "owned",
  unknown: "add",
  waiting: "owned",
  "waiting-children": "owned",
} as const satisfies Record<ExistingJobState, ExistingJobAction>;

const FRESH_ATTEMPTS = {
  resetAttemptsMade: true,
  resetAttemptsStarted: true,
} as const satisfies RetryOptions;

/** Structural, so both a real job and a plain fake satisfy it. */
type RequeueableJob = {
  getState: () => Promise<ExistingJobState>;
  remove: () => Promise<void>;
  retry: (state: FinishedStatus, options: RetryOptions) => Promise<void>;
};

type RequeueAddOptions = Pick<JobsOptions, "delay"> & { jobId: string };

/** The queue surface one re-enqueue needs, so a caller can pass a plain fake. */
export type RequeueableQueue<
  DataType,
  JobType extends RequeueableJob = RequeueableJob,
> = {
  add: (
    name: string,
    data: DataType,
    options: RequeueAddOptions,
  ) => Promise<unknown>;
  getJob: (jobId: string) => Promise<JobType | null | undefined>;
};

type RequeueDeterministicJobOptions<
  DataType,
  JobType extends RequeueableJob,
> = {
  data: DataType;
  delayMs?: number;
  jobId: string;
  name: string;
  operationTimeoutMs?: number;
  queue: RequeueableQueue<DataType, JobType>;
  /**
   * Builds the re-added job's data from the completed job it replaces, for a
   * job whose data names something the earlier run already wrote.
   */
  reclaimData?: (previous: JobType) => DataType;
};

/**
 * Hand one persisted row back to its queue under the row's own job id. The
 * one place a deterministic job id is reused; `confine-owner` rejects state
 * reads elsewhere.
 *
 * `add` alone is not the idempotent operation a reconciler needs. The queue
 * ignores an `add` whose id it still holds, and retention keeps terminal
 * records long after the row they ran for was reopened, so re-adding under
 * such an id would be dropped without an error. Every state a job can report
 * maps to one action in `EXISTING_JOB_ACTION`.
 */
export const requeueDeterministicJob = async <
  DataType,
  JobType extends RequeueableJob,
>({
  data,
  delayMs,
  jobId,
  name,
  operationTimeoutMs = QUEUE_OPERATION_TIMEOUT_MS,
  queue,
  reclaimData,
}: RequeueDeterministicJobOptions<
  DataType,
  JobType
>): Promise<QueueRequeueOutcome> => {
  const bounded = async <T>(
    label: string,
    command: () => Promise<T>,
  ): Promise<T> =>
    await withTimeout(async () => await command(), {
      label: `queue-requeue.${label}`,
      timeoutMs: operationTimeoutMs,
    });

  const add = async (jobData: DataType): Promise<QueueRequeueOutcome> => {
    await bounded(
      "add-job",
      async () =>
        await queue.add(name, jobData, {
          jobId,
          ...(delayMs === undefined ? {} : { delay: Math.max(0, delayMs) }),
        }),
    );
    return QUEUE_REQUEUE_OUTCOME.REQUEUED;
  };

  const existing = await bounded(
    "get-job",
    async () => await queue.getJob(jobId),
  );
  if (!existing) {
    return await add(data);
  }

  const state = await bounded(
    "get-state",
    async () => await existing.getState(),
  );
  const action = EXISTING_JOB_ACTION[state];
  switch (action) {
    case "owned": {
      return QUEUE_REQUEUE_OUTCOME.QUEUE_OWNED;
    }
    case "retry": {
      if (delayMs !== undefined && delayMs > 0) {
        await bounded("remove-job", async () => await existing.remove());
        return await add(data);
      }
      await bounded(
        "retry-job",
        async () => await existing.retry("failed", FRESH_ATTEMPTS),
      );
      return QUEUE_REQUEUE_OUTCOME.REQUEUED;
    }
    case "reclaim": {
      await bounded("remove-job", async () => await existing.remove());
      return await add(reclaimData ? reclaimData(existing) : data);
    }
    case "add": {
      return await add(data);
    }
    default: {
      action satisfies never;
      return panic(`Unhandled existing job action: ${String(action)}`);
    }
  }
};
