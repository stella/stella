import { withTimeout } from "@/api/lib/with-timeout";

/**
 * Deadline on one queue command.
 *
 * The client does not time these out on its own, so a broker that accepts the
 * connection and then stops answering leaves every command pending. A sweep
 * runs many of them, and its scheduler lease is measured in minutes: without a
 * bound the whole tick would sit on the first unanswered command and be killed
 * with nothing recorded. Failing fast instead makes the stall a captured error
 * per row, and the next tick retries. Matches the bound the other queue
 * handoffs use.
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

/** Structural, so both a real job and a plain fake satisfy it. */
type RequeueableJob = {
  getState: () => Promise<string>;
  remove: () => Promise<void>;
  retry: () => Promise<void>;
};

/** The queue surface one re-enqueue needs, so a caller can pass a plain fake. */
export type RequeueableQueue<DataType> = {
  add: (
    name: string,
    data: DataType,
    options: { jobId: string },
  ) => Promise<unknown>;
  getJob: (jobId: string) => Promise<RequeueableJob | null | undefined>;
};

type RequeueDeterministicJobOptions<DataType> = {
  data: DataType;
  jobId: string;
  name: string;
  queue: RequeueableQueue<DataType>;
};

/**
 * Hand one persisted row back to its queue under the row's own job id.
 *
 * `add` alone is not the idempotent operation a reconciler needs. The queue
 * ignores an `add` whose id it still holds, and retention keeps terminal
 * records long after the row they ran for was reopened, so re-adding under
 * such an id is dropped without an error and the row stays pending forever. A
 * terminal record is therefore retried or reclaimed, while a job in any live
 * state is left alone: it is the enqueue this sweep would otherwise duplicate.
 */
export const requeueDeterministicJob = async <DataType>({
  data,
  jobId,
  name,
  queue,
}: RequeueDeterministicJobOptions<DataType>): Promise<QueueRequeueOutcome> => {
  const bounded = async <T>(
    label: string,
    command: () => Promise<T>,
  ): Promise<T> =>
    await withTimeout(async () => await command(), {
      label: `queue-requeue.${label}`,
      timeoutMs: QUEUE_OPERATION_TIMEOUT_MS,
    });

  const existing = await bounded(
    "get-job",
    async () => await queue.getJob(jobId),
  );
  if (existing) {
    const state = await bounded(
      "get-state",
      async () => await existing.getState(),
    );
    if (state === "failed") {
      await bounded("retry-job", async () => await existing.retry());
      return QUEUE_REQUEUE_OUTCOME.REQUEUED;
    }
    if (state !== "completed") {
      return QUEUE_REQUEUE_OUTCOME.QUEUE_OWNED;
    }
    await bounded("remove-job", async () => await existing.remove());
  }

  await bounded("add-job", async () => await queue.add(name, data, { jobId }));
  return QUEUE_REQUEUE_OUTCOME.REQUEUED;
};
