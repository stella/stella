import { panic } from "better-result";
import { Queue } from "bullmq";

import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import type { BullMqQueueName } from "@/api/lib/bullmq-queue";
import { ConfigurationError } from "@/api/lib/errors/tagged-errors";
import type { MemberRunQueue } from "@/api/lib/member-run-queues";
import { createBullMqConnection } from "@/api/lib/redis-client";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

/**
 * Whose authority each queue's jobs run under. A scheduler job row names its
 * target queue as data and carries no member, so it may only feed queues whose
 * jobs act for no member (`org-automation`). Total over `BullMqQueueName`, and
 * every queue in `MEMBER_RUN_QUEUES` must stay `member-run`, so a new queue
 * needs a decision here before it compiles. `unclassified` mirrors queues whose
 * authority `scripts/ownership.ts` has not classified yet; dispatch refuses
 * them like member runs until it does.
 */
type QueueAuthority = "org-automation" | "member-run" | "unclassified";

const SCHEDULED_DISPATCH_QUEUE_AUTHORITY = {
  "account-deletion-cleanup": "org-automation",
  "bilingual-translation-runs": "member-run",
  "document-deadline-scouts": "org-automation",
  "document-processing": "org-automation",
  "document-review-runs-v2": "member-run",
  "document-translation-runs": "member-run",
  "entity-deletion-cleanup": "org-automation",
  "file-derivatives": "org-automation",
  "flow-run": "unclassified",
  "legal-list-verification-runs": "member-run",
  "report-exports": "member-run",
  "style-set-package-cleanup": "org-automation",
  workflow: "unclassified",
  "workflow-flex": "unclassified",
} as const satisfies Record<BullMqQueueName, QueueAuthority> &
  Record<MemberRunQueue, "member-run">;

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
  Object.hasOwn(SCHEDULED_DISPATCH_QUEUE_AUTHORITY, name);

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

  const authority = SCHEDULED_DISPATCH_QUEUE_AUTHORITY[queueName];
  switch (authority) {
    case "org-automation":
      return {
        status: "accepted",
        payload: { jobName, queueName, ...(data && { data }) },
      };
    case "member-run":
    case "unclassified":
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
