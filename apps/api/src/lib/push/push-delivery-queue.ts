import type { Queue } from "bullmq";

import { chunk } from "@stll/concurrency/chunk";

import { detached } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import { isMobilePushConfigured } from "@/api/lib/push/apns-config";
import { withTimeout } from "@/api/lib/with-timeout";

export const PUSH_DELIVERY_QUEUE_NAME = "push-notifications";
const PUSH_DELIVERY_JOB_NAME = "deliver";

/** Jobs per `addBulk`, so a firm-wide announcement is a few round trips. */
const ENQUEUE_BATCH_SIZE = 100;
const QUEUE_OPERATION_TIMEOUT_MS = 2000;

/**
 * One notification to alert its recipient's devices about. The job names the
 * notification only: the worker reads the recipient and organization from the
 * row, never from the job.
 */
export type PushDeliveryJobData = {
  notificationId: string;
  /**
   * Devices an earlier attempt already reached, so a retry after a partial
   * failure alerts only the rest.
   */
  deliveredTokens?: string[];
};

/**
 * Retries back off from fifteen seconds; five attempts span about four
 * minutes, after which an alert would arrive too late to be worth sending.
 * Finished jobs are kept for a day, which is what makes a second enqueue of
 * the same notification a no-op.
 */
const PUSH_DELIVERY_JOB_ATTEMPTS = 5;

const getQueue = createLazyBullMqQueue<PushDeliveryJobData>({
  name: PUSH_DELIVERY_QUEUE_NAME,
  connectionOptions: {
    connectionTimeout: QUEUE_OPERATION_TIMEOUT_MS,
    enableOfflineQueue: false,
  },
  defaultJobOptions: {
    attempts: PUSH_DELIVERY_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 15_000 },
    removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
    removeOnFail: { age: 7 * 24 * 60 * 60, count: 1000 },
  },
});

/** One job per notification, so a redelivered enqueue is ignored by id. */
export const pushDeliveryJobId = (notificationId: string): string =>
  createBullMqJobId(notificationId, PUSH_DELIVERY_JOB_NAME);

export type PushDeliveryQueue = Pick<Queue<PushDeliveryJobData>, "addBulk">;

export const enqueuePushDeliveries = async (
  notificationIds: readonly SafeId<"notification">[],
  queue: PushDeliveryQueue = getQueue(),
): Promise<void> => {
  for (const batch of chunk(
    [...new Set(notificationIds)],
    ENQUEUE_BATCH_SIZE,
  )) {
    await withTimeout(
      async () =>
        await queue.addBulk(
          batch.map((notificationId) => ({
            name: PUSH_DELIVERY_JOB_NAME,
            data: { notificationId },
            opts: { jobId: pushDeliveryJobId(notificationId) },
          })),
        ),
      {
        label: "push-delivery.enqueue",
        timeoutMs: QUEUE_OPERATION_TIMEOUT_MS,
      },
    );
  }
};

type SchedulePushDeliveriesOptions = {
  configured?: () => boolean;
  enqueue?: (ids: readonly SafeId<"notification">[]) => Promise<void>;
};

/**
 * Queue alerts for notifications whose transaction has committed.
 *
 * Fire and forget by design: an alert is a nudge and the in-app notification
 * is the record, so a queue outage is captured and the caller's write, which
 * has already succeeded, is not failed or delayed by it. Nothing is queued
 * while push is not configured.
 */
export const schedulePushDeliveries = (
  notificationIds: readonly SafeId<"notification">[],
  {
    configured = isMobilePushConfigured,
    enqueue = enqueuePushDeliveries,
  }: SchedulePushDeliveriesOptions = {},
): void => {
  if (notificationIds.length === 0 || !configured()) {
    return;
  }
  detached(enqueue(notificationIds), "push-delivery.enqueue");
};
