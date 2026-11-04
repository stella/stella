import { TaggedError } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import type { TimerActivityTimer } from "@stll/api-contract/timer-activity";
import { Temporal } from "@stll/time";

import { timeTimers, workspaces } from "@/api/db/schema";
import { detached } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { BullMqWorker, createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import type { BullMqWorkerContext } from "@/api/lib/bullmq-queue";
import type { BoundedReadResult } from "@/api/lib/db/read-bounded";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  createApnsClient,
  createHttp2ApnsTransport,
} from "@/api/lib/push/apns-client";
import type { ApnsActivityPush, ApnsOutcome } from "@/api/lib/push/apns-client";
import {
  isMobilePushConfigured,
  readApnsCredentials,
} from "@/api/lib/push/apns-config";
import { createApnsProviderToken } from "@/api/lib/push/apns-provider-token";
import {
  claimTimerActivityStart,
  forgetTimerActivityToken,
  listTimerActivityDevices,
  releaseTimerActivityStart,
} from "@/api/lib/push/timer-activity-devices";
import type { TimerActivityDevice } from "@/api/lib/push/timer-activity-devices";
import { timerActivityPushFor } from "@/api/lib/push/timer-activity-payload";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { createRootMembershipScopedDb } from "@/api/lib/root-scoped-db";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { withTimeout } from "@/api/lib/with-timeout";

export const TIMER_ACTIVITY_QUEUE_NAME = "timer-activity-updates";
const TIMER_ACTIVITY_JOB_NAME = "update";
const QUEUE_OPERATION_TIMEOUT_MS = 2000;
const WORKER_CONCURRENCY = 10;

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

/** What the update reads and writes, injected so tests run without a gateway. */
export type TimerActivityDeps = {
  listDevices: (
    owner: TimerOwnerChange,
  ) => Promise<BoundedReadResult<TimerActivityDevice>>;
  /** The person's timers, with the names of the matters they can still reach. */
  readTimers: (owner: TimerOwnerChange) => Promise<{
    timers: TimerActivityTimer[];
    matterNames: ReadonlyMap<string, string>;
  }>;
  claimStart: (
    owner: TimerOwnerChange,
    device: TimerActivityDevice,
  ) => Promise<boolean>;
  releaseStart: (
    owner: TimerOwnerChange,
    device: TimerActivityDevice,
  ) => Promise<void>;
  forgetToken: (
    owner: TimerOwnerChange,
    device: TimerActivityDevice,
    token: "start" | "activity",
  ) => Promise<void>;
  send: (push: ApnsActivityPush) => Promise<ApnsOutcome>;
  now: () => number;
};

export type TimerActivityResult =
  | {
      status: "skipped";
      reason: "invalid_job" | "no_devices" | "too_many_devices";
    }
  | {
      status: "sent";
      sent: number;
      retryable: number;
      rejected: { reason: string; status: number }[];
    };

const jobSchema = v.object({
  organizationId: v.pipe(v.string(), v.minLength(1)),
  userId: v.pipe(v.string(), v.minLength(1)),
});

/** One phone: send what it needs and keep the row in step with the outcome. */
const updateDevice = async (
  owner: TimerOwnerChange,
  device: TimerActivityDevice,
  state: Awaited<ReturnType<TimerActivityDeps["readTimers"]>>,
  deps: TimerActivityDeps,
): Promise<ApnsOutcome | null> => {
  const push = timerActivityPushFor({
    device,
    matterNames: state.matterNames,
    now: deps.now(),
    timers: state.timers,
  });
  if (push.type === "none") {
    return null;
  }
  if (push.type === "start" && !(await deps.claimStart(owner, device))) {
    return null;
  }
  const outcome = await deps.send({
    environment: device.environment,
    token: push.token,
    bundleId: device.bundleId,
    payload: push.payload,
  });
  const tokenKind = push.type === "start" ? "start" : "activity";
  if (
    outcome.type === "device_gone" ||
    (push.type === "end" && outcome.type === "delivered")
  ) {
    await deps.forgetToken(owner, device, tokenKind);
  }
  if (push.type === "start" && outcome.type !== "delivered") {
    await deps.releaseStart(owner, device);
  }
  return outcome;
};

/**
 * Bring each of a person's registered phones in step with their timers.
 *
 * Replay-safe: every run reads the timers afresh and sends each phone the
 * whole state, a start is claimed before it is sent, and iOS drops an update
 * older than the one it shows.
 */
export const updateTimerActivities = async (
  data: TimerActivityJobData,
  deps: TimerActivityDeps,
): Promise<TimerActivityResult> => {
  const parsed = v.safeParse(jobSchema, data);
  if (!parsed.success) {
    return { status: "skipped", reason: "invalid_job" };
  }
  const owner = {
    organizationId: brandPersistedOrganizationId(parsed.output.organizationId),
    userId: brandPersistedUserId(parsed.output.userId),
  };
  const listed = await deps.listDevices(owner);
  if (listed.type === "overflow") {
    return { status: "skipped", reason: "too_many_devices" };
  }
  if (listed.rows.length === 0) {
    return { status: "skipped", reason: "no_devices" };
  }
  const state = await deps.readTimers(owner);
  const outcomes = (
    await Promise.all(
      listed.rows.map(
        async (device) => await updateDevice(owner, device, state, deps),
      ),
    )
  ).filter((outcome) => outcome !== null);
  return {
    status: "sent",
    sent: outcomes.filter(({ type }) => type === "delivered").length,
    retryable: outcomes.filter(({ type }) => type === "retry").length,
    rejected: outcomes.flatMap((outcome) =>
      outcome.type === "rejected"
        ? [{ reason: outcome.reason, status: outcome.status }]
        : [],
    ),
  };
};

const createDeps = (
  db: BullMqWorkerContext["db"],
  send: TimerActivityDeps["send"],
): TimerActivityDeps => ({
  listDevices: async (owner) => await listTimerActivityDevices(db, owner),
  // The timers are the person's own; the matter names are read under their
  // membership as it stands now, so a matter they lost is not named.
  readTimers: async (owner) => {
    const rows = await db
      .select({
        id: timeTimers.id,
        matterId: timeTimers.workspaceId,
        description: timeTimers.description,
        state: timeTimers.state,
        accumulatedSeconds: timeTimers.accumulatedSeconds,
        lastResumedAt: timeTimers.lastResumedAt,
      })
      .from(timeTimers)
      .where(
        and(
          eq(timeTimers.organizationId, owner.organizationId),
          eq(timeTimers.userId, owner.userId),
        ),
      );
    const matterIds = [
      ...new Set(
        rows.flatMap(({ matterId }) => (matterId === null ? [] : [matterId])),
      ),
    ];
    const matters =
      matterIds.length === 0
        ? []
        : await createRootMembershipScopedDb(owner)(
            async (tx) =>
              await tx
                .select({ id: workspaces.id, name: workspaces.name })
                .from(workspaces)
                .where(inArray(workspaces.id, matterIds)),
          );
    return {
      timers: rows.map((row) => ({
        ...row,
        lastResumedAt: row.lastResumedAt?.toISOString() ?? null,
      })),
      matterNames: new Map(matters.map(({ id, name }) => [id, name])),
    };
  },
  claimStart: async (owner, device) =>
    await claimTimerActivityStart(db, { userId: owner.userId, device }),
  releaseStart: async (owner, device) => {
    await releaseTimerActivityStart(db, { userId: owner.userId, device });
  },
  forgetToken: async (owner, device, token) => {
    await forgetTimerActivityToken(db, { userId: owner.userId, device, token });
  },
  send,
  now: () => Temporal.Now.instant().epochMilliseconds,
});

/** Some phones are worth another attempt; BullMQ backs off and retries. */
class TimerActivityRetryError extends TaggedError("TimerActivityRetryError")<{
  message: string;
}> {}

/** APNs refused an update in a way a retry would not change. */
class TimerActivityRejectedError extends TaggedError(
  "TimerActivityRejectedError",
)<{ message: string; reason: string; status: number }> {}

const REJECTED_SINK = failureSink({
  event: "timer_activity.rejected",
  expected: [],
});
const FAILED_SINK = failureSink({
  event: "timer_activity.failed",
  expected: [],
});

/**
 * The worker that updates Lock Screens. It starts with every API host so the
 * queue always drains; with APNs unconfigured nothing is enqueued, and a job
 * left over from a configured deploy is dropped rather than sent.
 */
export const initTimerActivityWorker = ({ db }: BullMqWorkerContext) => {
  const credentials = readApnsCredentials();
  const client =
    credentials === null
      ? null
      : createApnsClient({
          transport: createHttp2ApnsTransport(),
          providerToken: createApnsProviderToken({ credentials }),
        });
  const deps =
    client === null
      ? null
      : createDeps(db, async (push) => await client.sendActivity(push));

  const worker = new BullMqWorker<TimerActivityJobData>(
    TIMER_ACTIVITY_QUEUE_NAME,
    async (job) => {
      if (deps === null) {
        return;
      }
      const result = await updateTimerActivities(job.data, deps);
      if (result.status !== "sent") {
        if (result.reason === "too_many_devices") {
          logger.warn("timer_activity.too_many_devices", {
            userId: job.data.userId,
          });
        }
        return;
      }
      const [rejected] = result.rejected;
      if (rejected !== undefined) {
        observeFailure(
          new TimerActivityRejectedError({
            message: "APNs refused a Live Activity update",
            reason: rejected.reason,
            status: rejected.status,
          }),
          { sink: REJECTED_SINK, ctx: { queue: TIMER_ACTIVITY_QUEUE_NAME } },
        );
      }
      if (result.retryable > 0) {
        throw new TimerActivityRetryError({
          message: "Some phones could not be reached yet",
        });
      }
    },
    {
      connection: createBullMqConnection({
        storeClass: "durable-coordination",
      }),
      concurrency: WORKER_CONCURRENCY,
    },
  );

  worker.on("failed", (job, error) => {
    const exhausted =
      job === undefined || job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted && error instanceof TimerActivityRetryError) {
      return;
    }
    observeFailure(error, {
      sink: FAILED_SINK,
      ctx: { queue: TIMER_ACTIVITY_QUEUE_NAME },
    });
  });
  worker.on(
    "error",
    createQueueWorkerErrorLogger("timer_activity.worker_error"),
  );

  logger.info("timer_activity.worker_started", {
    concurrency: String(WORKER_CONCURRENCY),
    configured: String(client !== null),
  });

  return {
    queues: [TIMER_ACTIVITY_QUEUE_NAME] as const,
    close: async () => {
      await worker.close();
      client?.close();
    },
  };
};
