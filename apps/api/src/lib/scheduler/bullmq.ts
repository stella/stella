import { Queue } from "bullmq";
import Redis from "ioredis";

import { env } from "@/api/env";
import { ConfigurationError } from "@/api/lib/errors/tagged-errors";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

type QueueCache = {
  redis: Redis | null;
  queues: Map<string, Queue>;
};

type BullMqSchedulerPayload = {
  data?: Record<string, unknown>;
  jobName: string;
  queueName: string;
};

const cache: QueueCache = {
  redis: null,
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
    await queue.add(payload.jobName, {
      schedulerJobId: job.id,
      schedulerRunId: runId,
      ...(payload.data && { payload: payload.data }),
    });
  };

const getRedis = (): Redis => {
  cache.redis ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return cache.redis;
};

const getSchedulerQueue = (queueName: string): Queue => {
  const existing = cache.queues.get(queueName);
  if (existing) {
    return existing;
  }

  const queue = new Queue(queueName, {
    connection: getRedis(),
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
