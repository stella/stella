import { Queue } from "bullmq";

import { ConfigurationError } from "@/api/lib/errors/tagged-errors";
import { createBullMqConnection } from "@/api/lib/redis-client";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

type QueueCache = {
  connection: ReturnType<typeof createBullMqConnection> | null;
  queues: Map<string, Queue>;
};

type BullMqSchedulerPayload = {
  data?: Record<string, unknown>;
  jobName: string;
  queueName: string;
};

const cache: QueueCache = {
  connection: null,
  queues: new Map(),
};

export const createBullMqDispatchTask =
  (): SchedulerTask =>
  async ({ job, payload, runId }) => {
    if (!isBullMqSchedulerPayload(payload)) {
      throw new ConfigurationError({
        message: `Scheduler job ${job.id} has invalid BullMQ payload`,
      });
    }

    const queue = getSchedulerQueue(payload.queueName);
    // Deterministic jobId so a re-fired scheduler run (retry, or a DST
    // double-fire) enqueues at most one BullMQ job: a second add with the
    // same jobId is ignored while the first exists.
    await queue.add(
      payload.jobName,
      {
        schedulerJobId: job.id,
        schedulerRunId: runId,
        ...(payload.data && { payload: payload.data }),
      },
      { jobId: `scheduler:${job.id}:${runId}` },
    );
  };

const getConnection = () => {
  cache.connection ??= createBullMqConnection();
  return cache.connection;
};

const getSchedulerQueue = (queueName: string): Queue => {
  const existing = cache.queues.get(queueName);
  if (existing) {
    return existing;
  }

  const queue = new Queue(queueName, {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
  cache.queues.set(queueName, queue);
  return queue;
};

const isBullMqSchedulerPayload = (
  value: unknown,
): value is BullMqSchedulerPayload => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const queueName = "queueName" in value ? value.queueName : undefined;
  const jobName = "jobName" in value ? value.jobName : undefined;
  const data = "data" in value ? value.data : undefined;

  return (
    typeof queueName === "string" &&
    typeof jobName === "string" &&
    (data === undefined ||
      (typeof data === "object" && data !== null && !Array.isArray(data)))
  );
};
