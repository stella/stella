import { panic } from "better-result";
import { Queue } from "bullmq";

import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import type { BullMqQueueName } from "@/api/lib/bullmq-queue";
import { ConfigurationError } from "@/api/lib/errors/tagged-errors";
import { QUEUE_AUTHORITY } from "@/api/lib/member-run-queues";
import { createBullMqConnection } from "@/api/lib/redis-client";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

type QueueCache = {
  connection: ReturnType<typeof createBullMqConnection> | null;
  queues: Map<BullMqQueueName, Queue>;
};

type BullMqSchedulerPayload = {
  data?: Record<string, unknown>;
  jobName: string;
  queueName: BullMqQueueName;
};

type BullMqDispatchTaskOptions = {
  createConnection?: typeof createBullMqConnection;
};

const cache: QueueCache = {
  connection: null,
  queues: new Map(),
};

export const createBullMqDispatchTask =
  ({
    createConnection = createBullMqConnection,
  }: BullMqDispatchTaskOptions = {}): SchedulerTask =>
  async ({ job, payload, runId }) => {
    const parsed = parseBullMqSchedulerPayload(payload);
    if (parsed.status === "refused") {
      // The runner records the run as failed and reports the error.
      throw new ConfigurationError({
        message: `Scheduler job ${job.id} ${parsed.reason}`,
      });
    }

    const { data, jobName, queueName } = parsed.payload;
    const queue = getSchedulerQueue(queueName, createConnection);
    const scheduledFor = job.nextRunAt.toISOString();
    // Deterministic per scheduled occurrence: if the runner crashes after
    // enqueue but before recording success, the retry run uses the same id.
    await queue.add(
      jobName,
      {
        schedulerJobId: job.id,
        schedulerRunId: runId,
        ...(data && { payload: data }),
      },
      { jobId: createBullMqJobId("scheduler", job.id, scheduledFor) },
    );
  };

const getConnection = (createConnection: typeof createBullMqConnection) => {
  cache.connection ??= createConnection({ storeClass: "durable-coordination" });
  return cache.connection;
};

const getSchedulerQueue = (
  queueName: BullMqQueueName,
  createConnection: typeof createBullMqConnection,
): Queue => {
  const existing = cache.queues.get(queueName);
  if (existing) {
    return existing;
  }

  const queue = new Queue(queueName, {
    connection: getConnection(createConnection),
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

const isQueueName = (name: string): name is BullMqQueueName =>
  Object.hasOwn(QUEUE_AUTHORITY, name);

const isPayloadData = (
  data: unknown,
): data is Record<string, unknown> | undefined =>
  data === undefined ||
  (typeof data === "object" && data !== null && !Array.isArray(data));

type ParsedBullMqSchedulerPayload =
  | { status: "accepted"; payload: BullMqSchedulerPayload }
  | { status: "refused"; reason: string };

const parseBullMqSchedulerPayload = (
  value: unknown,
): ParsedBullMqSchedulerPayload => {
  if (typeof value !== "object" || value === null) {
    return { status: "refused", reason: "has invalid BullMQ payload" };
  }

  const queueName = "queueName" in value ? value.queueName : undefined;
  const jobName = "jobName" in value ? value.jobName : undefined;
  const data = "data" in value ? value.data : undefined;

  if (
    typeof queueName !== "string" ||
    typeof jobName !== "string" ||
    !isPayloadData(data)
  ) {
    return { status: "refused", reason: "has invalid BullMQ payload" };
  }
  if (!isQueueName(queueName)) {
    return {
      status: "refused",
      reason: `names unknown BullMQ queue ${JSON.stringify(queueName)}`,
    };
  }

  // A scheduler job row names its queue as data and carries no member, so it
  // may only feed queues whose jobs act for no member.
  const { authority } = QUEUE_AUTHORITY[queueName];
  switch (authority) {
    case "org-automation":
      return {
        status: "accepted",
        payload: { jobName, queueName, ...(data && { data }) },
      };
    case "member-run":
      return {
        status: "refused",
        reason: `names ${authority} queue ${queueName}; scheduled dispatch accepts org-automation queues only`,
      };
    default: {
      authority satisfies never;
      return panic(`Unhandled queue authority for ${queueName}`);
    }
  }
};
