import { detached } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import { isMobilePushConfigured } from "@/api/lib/push/apns-config";
import { withTimeout } from "@/api/lib/with-timeout";

export const TIMER_ACTIVITY_QUEUE_NAME = "timer-activity-updates";
const TIMER_ACTIVITY_JOB_NAME = "update";
const QUEUE_OPERATION_TIMEOUT_MS = 2000;

/**
 * Whose timers changed. The job carries no timer: the worker reads them as
 * they stand when it runs, so jobs for quick changes in a row all draw the
 * latest, and the payload's timestamp keeps an older one from winning.
 */
export type TimerActivityJobData = {
  organizationId: string;
  userId: string;
};

const getQueue = createLazyBullMqQueue<TimerActivityJobData>({
  name: TIMER_ACTIVITY_QUEUE_NAME,
  connectionOptions: {
    connectionTimeout: QUEUE_OPERATION_TIMEOUT_MS,
    enableOfflineQueue: false,
  },
  // A Lock Screen a few minutes behind is worth correcting; one an hour
  // behind is corrected by the app when it next opens.
  defaultJobOptions: {
    attempts: 4,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 60 * 60, count: 1000 },
    removeOnFail: { age: 24 * 60 * 60, count: 1000 },
  },
});

export type TimerOwnerChange = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

/**
 * Bring the Lock Screens of these people up to date with their timers, once
 * the transaction that changed the timers has committed.
 *
 * Fire and forget: the Lock Screen follows the timer, never the other way
 * round, so a queue outage is captured and the write that changed the timer
 * is not failed or delayed by it. Nothing is queued while push is off.
 */
export const scheduleTimerActivityUpdates = (
  owners: readonly TimerOwnerChange[],
  { configured = isMobilePushConfigured }: { configured?: () => boolean } = {},
): void => {
  if (owners.length === 0 || !configured()) {
    return;
  }
  detached(
    async () =>
      await withTimeout(
        async () =>
          await getQueue().addBulk(
            owners.map((owner) => ({
              name: TIMER_ACTIVITY_JOB_NAME,
              data: {
                organizationId: owner.organizationId,
                userId: owner.userId,
              },
            })),
          ),
        {
          label: "timer-activity.enqueue",
          timeoutMs: QUEUE_OPERATION_TIMEOUT_MS,
        },
      ),
    "timer-activity.enqueue",
  );
};
