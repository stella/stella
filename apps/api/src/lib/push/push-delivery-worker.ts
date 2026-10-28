import { TaggedError } from "better-result";
import type { Job } from "bullmq";
import { and, eq, isNull } from "drizzle-orm";
import * as v from "valibot";

import { isMobilePushKind } from "@stll/api-contract/mobile-push";

import { notifications } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { BullMqWorker } from "@/api/lib/bullmq-queue";
import type { BullMqWorkerContext } from "@/api/lib/bullmq-queue";
import { errorTag } from "@/api/lib/errors/utils";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { logger } from "@/api/lib/observability/logger";
import {
  createApnsClient,
  createHttp2ApnsTransport,
} from "@/api/lib/push/apns-client";
import type {
  ApnsAlert,
  ApnsClient,
  ApnsOutcome,
} from "@/api/lib/push/apns-client";
import { readApnsCredentials } from "@/api/lib/push/apns-config";
import { createApnsProviderToken } from "@/api/lib/push/apns-provider-token";
import { PUSH_DELIVERY_QUEUE_NAME } from "@/api/lib/push/push-delivery-queue";
import type { PushDeliveryJobData } from "@/api/lib/push/push-delivery-queue";
import {
  listDeliverableDevices,
  removeDeadPushDevices,
} from "@/api/lib/push/push-devices";
import type { DeliverableDevice } from "@/api/lib/push/push-devices";
import { buildMobilePushPayload } from "@/api/lib/push/push-payload";
import type { PushNotificationPointer } from "@/api/lib/push/push-payload";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { createRootMembershipScopedDb } from "@/api/lib/root-scoped-db";
import {
  brandPersistedNotificationId,
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";

const WORKER_CONCURRENCY = 10;

/** Who a notification is for, read from its row. */
export type PushRecipient = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
};

/** What delivery reads and writes, injected so tests run without a gateway. */
export type PushDeliveryDeps = {
  /** The row's recipient, through the owner connection; null when it is gone. */
  readRecipient: (
    notificationId: SafeId<"notification">,
  ) => Promise<PushRecipient | null>;
  /**
   * The notification as its recipient sees it now, with their unread count:
   * null once it is read, or once they cannot reach the matter it points into.
   */
  readAsRecipient: (
    recipient: PushRecipient,
    notificationId: SafeId<"notification">,
  ) => Promise<{
    notification: PushNotificationPointer;
    unreadCount: number;
  } | null>;
  listDevices: (recipient: PushRecipient) => Promise<DeliverableDevice[]>;
  removeDevices: (
    recipient: PushRecipient,
    devices: readonly DeliverableDevice[],
  ) => Promise<number>;
  send: (alert: ApnsAlert) => Promise<ApnsOutcome>;
};

export type PushDeliveryResult =
  | {
      status: "skipped";
      reason:
        | "invalid_job"
        | "not_found"
        | "not_unread"
        | "not_pushed"
        | "no_devices";
    }
  | {
      status: "sent";
      /** Tokens reached by this attempt or an earlier one. */
      deliveredTokens: string[];
      /** Devices APNs called dead, now removed. */
      removed: number;
      /** Devices worth another attempt. */
      retryable: number;
      /** Alerts APNs refused for a reason a retry would not change. */
      rejected: { reason: string; status: number }[];
    };

const notificationIdSchema = v.pipe(v.string(), v.uuid());

/**
 * Alert a notification's recipient on each device they registered in the
 * notification's organization.
 *
 * Replay-safe: an already-read or no-longer-visible notification sends
 * nothing, tokens an earlier attempt reached are skipped, and every alert
 * carries the notification id as its collapse id, so a device that does see
 * it twice shows it once.
 */
export const deliverPushNotification = async (
  data: PushDeliveryJobData,
  deps: PushDeliveryDeps,
): Promise<PushDeliveryResult> => {
  const parsedId = v.safeParse(notificationIdSchema, data.notificationId);
  if (!parsedId.success) {
    return { status: "skipped", reason: "invalid_job" };
  }
  const notificationId = brandPersistedNotificationId(parsedId.output);
  const recipient = await deps.readRecipient(notificationId);
  if (recipient === null) {
    return { status: "skipped", reason: "not_found" };
  }
  const visible = await deps.readAsRecipient(recipient, notificationId);
  if (visible === null) {
    return { status: "skipped", reason: "not_unread" };
  }
  // Only kinds that ask something of the person reach a phone; a job for
  // another kind (queued before the list narrowed) sends nothing.
  if (!isMobilePushKind(visible.notification.kind)) {
    return { status: "skipped", reason: "not_pushed" };
  }
  const alreadyDelivered = new Set(data.deliveredTokens);
  const devices = (await deps.listDevices(recipient)).filter(
    (device) => !alreadyDelivered.has(device.token),
  );
  if (devices.length === 0) {
    return { status: "skipped", reason: "no_devices" };
  }

  const outcomes = await Promise.all(
    devices.map(async (device) => ({
      device,
      outcome: await deps.send({
        environment: device.environment,
        token: device.token,
        bundleId: device.bundleId,
        collapseId: visible.notification.id,
        payload: buildMobilePushPayload({
          notification: visible.notification,
          locale: device.locale,
          unreadCount: visible.unreadCount,
        }),
      }),
    })),
  );

  const gone = outcomes
    .filter(({ outcome }) => outcome.type === "device_gone")
    .map(({ device }) => device);
  const removed = await deps.removeDevices(recipient, gone);
  return {
    status: "sent",
    deliveredTokens: [
      ...alreadyDelivered,
      ...outcomes
        .filter(({ outcome }) => outcome.type === "delivered")
        .map(({ device }) => device.token),
    ],
    removed,
    retryable: outcomes.filter(({ outcome }) => outcome.type === "retry")
      .length,
    rejected: outcomes.flatMap(({ outcome }) =>
      outcome.type === "rejected"
        ? [{ reason: outcome.reason, status: outcome.status }]
        : [],
    ),
  };
};

/** Some devices are worth another attempt; BullMQ backs off and retries. */
export class PushDeliveryRetryError extends TaggedError(
  "PushDeliveryRetryError",
)<{ message: string }> {}

/** APNs refused an alert in a way a retry would not change. */
export class PushDeliveryRejectedError extends TaggedError(
  "PushDeliveryRejectedError",
)<{ message: string; reason: string; status: number }> {}

const createDeliveryDeps = (
  db: BullMqWorkerContext["db"],
  client: ApnsClient,
): PushDeliveryDeps => ({
  readRecipient: async (notificationId) => {
    const [row] = await db
      .select({
        userId: notifications.userId,
        organizationId: notifications.organizationId,
      })
      .from(notifications)
      .where(eq(notifications.id, notificationId))
      .limit(1);
    return row === undefined
      ? null
      : {
          userId: brandPersistedUserId(row.userId),
          organizationId: brandPersistedOrganizationId(row.organizationId),
        };
  },
  // Read under the recipient's membership as it stands now: the same row
  // security that decides what their inbox shows decides whether they are
  // alerted, so a matter they lost since the notification was filed sends
  // nothing.
  readAsRecipient: async (recipient, notificationId) =>
    await createRootMembershipScopedDb(recipient)(async (tx) => {
      const unread = and(
        eq(notifications.userId, recipient.userId),
        eq(notifications.organizationId, recipient.organizationId),
        isNull(notifications.readAt),
      );
      const [row] = await tx
        .select({
          id: notifications.id,
          kind: notifications.kind,
          organizationId: notifications.organizationId,
          workspaceId: notifications.workspaceId,
          entityType: notifications.entityType,
          entityId: notifications.entityId,
        })
        .from(notifications)
        .where(and(eq(notifications.id, notificationId), unread))
        .limit(1);
      if (row === undefined) {
        return null;
      }
      return {
        notification: row,
        unreadCount: await tx.$count(notifications, unread),
      };
    }),
  listDevices: async (recipient) => await listDeliverableDevices(db, recipient),
  removeDevices: async (recipient, devices) =>
    await removeDeadPushDevices(db, { devices, userId: recipient.userId }),
  send: async (alert) => await client.send(alert),
});

const reportRejections = (
  job: Job<PushDeliveryJobData>,
  rejected: readonly { reason: string; status: number }[],
) => {
  const first = rejected.at(0);
  if (first === undefined) {
    return;
  }
  captureError(
    new PushDeliveryRejectedError({
      message: "APNs refused a push alert",
      reason: first.reason,
      status: first.status,
    }),
    handlerErrorContext("lib.initPushDeliveryWorker.rejected", {
      reason: first.reason,
      status: String(first.status),
      notificationId: job.data.notificationId,
    }),
  );
};

/**
 * The worker that sends alerts. It starts with every API host so the queue
 * always drains; with APNs unconfigured nothing is enqueued, and a job left
 * over from a configured deploy is dropped rather than sent.
 */
export const initPushDeliveryWorker = ({ db }: BullMqWorkerContext) => {
  const credentials = readApnsCredentials();
  const client =
    credentials === null
      ? null
      : createApnsClient({
          transport: createHttp2ApnsTransport(),
          providerToken: createApnsProviderToken({ credentials }),
        });
  const deps = client === null ? null : createDeliveryDeps(db, client);

  const worker = new BullMqWorker<PushDeliveryJobData>(
    PUSH_DELIVERY_QUEUE_NAME,
    async (job) => {
      if (deps === null) {
        return;
      }
      const result = await deliverPushNotification(job.data, deps);
      if (result.status !== "sent") {
        return;
      }
      reportRejections(job, result.rejected);
      if (result.retryable > 0) {
        // Record who has the alert before failing the attempt, so the retry
        // reaches only the devices still owed it.
        await job.updateData({
          ...job.data,
          deliveredTokens: result.deliveredTokens,
        });
        throw new PushDeliveryRetryError({
          message: "Some devices could not be reached yet",
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
    const notificationId = job?.data.notificationId ?? "";
    const exhausted =
      job === undefined || job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted && error instanceof PushDeliveryRetryError) {
      logger.info("push_delivery.retrying", {
        notificationId,
        attemptsMade: String(job?.attemptsMade ?? 0),
      });
      return;
    }
    captureError(
      error,
      handlerErrorContext("lib.initPushDeliveryWorker", { notificationId }),
    );
    logger.error("push_delivery.failed", {
      "error.type": errorTag(error),
      notificationId,
    });
  });
  worker.on(
    "error",
    createQueueWorkerErrorLogger("push_delivery.worker_error"),
  );

  logger.info("push_delivery.worker_started", {
    concurrency: String(WORKER_CONCURRENCY),
    configured: String(client !== null),
  });

  return {
    queues: [PUSH_DELIVERY_QUEUE_NAME] as const,
    close: async () => {
      await worker.close();
      client?.close();
    },
  };
};
