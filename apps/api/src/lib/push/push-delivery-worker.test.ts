import { describe, expect, test } from "bun:test";

import { MOBILE_PUSH_DATA_KEY } from "@stll/api-contract/mobile-push";

import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import type { ApnsAlert, ApnsOutcome } from "@/api/lib/push/apns-client";
import { deliverPushNotification } from "@/api/lib/push/push-delivery-worker";
import type {
  PushDeliveryDeps,
  PushRecipient,
} from "@/api/lib/push/push-delivery-worker";
import type { DeliverableDevice } from "@/api/lib/push/push-devices";
import type { PushNotificationPointer } from "@/api/lib/push/push-payload";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const NOTIFICATION_ID = "0198f7c4-0000-7000-8000-000000000001";

const recipient: PushRecipient = {
  userId: brandPersistedUserId("user-1"),
  organizationId: brandPersistedOrganizationId("org-1"),
};

const notification: PushNotificationPointer = {
  id: NOTIFICATION_ID,
  kind: "flow_run_awaiting_approval",
  organizationId: "org-1",
  workspaceId: "ws-1",
  entityType: "flow_run",
  entityId: "run-1",
};

const device = (
  index: number,
  overrides: Partial<DeliverableDevice> = {},
): DeliverableDevice => ({
  token: String(index).padStart(2, "0").repeat(32),
  environment: "production",
  bundleId: "app.stll.mobile",
  locale: "en",
  seenToken: asTestRaw<TimestampCasToken>(
    `2026-10-${String(index).padStart(2, "0")} 00:00:00+00`,
  ),
  ...overrides,
});

/**
 * A delivery wired to an in-memory store and a fake gateway that answers
 * each token from `answers` (delivered when unlisted).
 */
const harness = ({
  devices = [device(1)],
  answers = new Map<string, ApnsOutcome>(),
  owner = recipient,
  visible = true,
  pointer = notification,
}: {
  devices?: readonly DeliverableDevice[];
  answers?: Map<string, ApnsOutcome>;
  owner?: PushRecipient | null;
  visible?: boolean;
  pointer?: PushNotificationPointer;
} = {}) => {
  const sent: ApnsAlert[] = [];
  const removed: DeliverableDevice[][] = [];
  const deps: PushDeliveryDeps = {
    readRecipient: async () => await Promise.resolve(owner),
    readAsRecipient: async () =>
      await Promise.resolve(
        visible ? { notification: pointer, unreadCount: 4 } : null,
      ),
    listDevices: async () => await Promise.resolve([...devices]),
    removeDevices: async (_recipient, gone) => {
      removed.push([...gone]);
      return await Promise.resolve(gone.length);
    },
    send: async (alert) => {
      sent.push(alert);
      return await Promise.resolve(
        answers.get(alert.token) ?? { type: "delivered" },
      );
    },
  };
  return { deps, sent, removed };
};

describe("push delivery", () => {
  test("a kind that asks nothing of the person reaches no phone", async () => {
    const { deps, sent } = harness({
      pointer: {
        ...notification,
        kind: "report_export_succeeded",
        entityType: "report_export",
      },
    });
    expect(
      await deliverPushNotification({ notificationId: NOTIFICATION_ID }, deps),
    ).toEqual({ status: "skipped", reason: "not_pushed" });
    expect(sent).toEqual([]);
  });

  test("alerts every device with the kind's sentence, the badge and the collapse id", async () => {
    const devices = [device(1), device(2, { locale: "cs-CZ" })];
    const { deps, sent } = harness({ devices });

    const result = await deliverPushNotification(
      { notificationId: NOTIFICATION_ID },
      deps,
    );

    expect(result).toEqual({
      status: "sent",
      deliveredTokens: devices.map(({ token }) => token),
      removed: 0,
      retryable: 0,
      rejected: [],
    });
    expect(sent.map(({ collapseId }) => collapseId)).toEqual([
      NOTIFICATION_ID,
      NOTIFICATION_ID,
    ]);
    expect(sent.map(({ payload }) => payload.aps)).toEqual([
      {
        alert: { body: "A workflow is waiting for your approval" },
        sound: "default",
        badge: 4,
      },
      {
        alert: { body: "Pracovní postup čeká na vaše schválení" },
        sound: "default",
        badge: 4,
      },
    ]);
    expect(sent[0]?.payload[MOBILE_PUSH_DATA_KEY]).toEqual({
      v: 1,
      kind: "flow_run_awaiting_approval",
      notificationId: NOTIFICATION_ID,
      organizationId: "org-1",
      workspaceId: "ws-1",
      entityType: "flow_run",
      entityId: "run-1",
    });
  });

  test("a token APNs calls dead is removed, and the rest still delivered", async () => {
    const gone = device(1);
    const unregistered = device(2);
    const live = device(3);
    const { deps, removed } = harness({
      devices: [gone, unregistered, live],
      answers: new Map<string, ApnsOutcome>([
        [gone.token, { type: "device_gone", reason: "BadDeviceToken" }],
        [unregistered.token, { type: "device_gone", reason: "Unregistered" }],
      ]),
    });

    const result = await deliverPushNotification(
      { notificationId: NOTIFICATION_ID },
      deps,
    );

    expect(removed).toEqual([[gone, unregistered]]);
    expect(result).toMatchObject({
      status: "sent",
      deliveredTokens: [live.token],
      removed: 2,
      retryable: 0,
    });
  });

  test("a throttled or failed device is counted for retry, and a retry skips the devices already reached", async () => {
    const reached = device(1);
    const throttled = device(2);
    const first = harness({
      devices: [reached, throttled],
      answers: new Map<string, ApnsOutcome>([
        [throttled.token, { type: "retry", reason: "TooManyRequests" }],
      ]),
    });

    const attempt = await deliverPushNotification(
      { notificationId: NOTIFICATION_ID },
      first.deps,
    );
    expect(attempt).toMatchObject({
      status: "sent",
      deliveredTokens: [reached.token],
      retryable: 1,
    });

    const second = harness({ devices: [reached, throttled] });
    const retry = await deliverPushNotification(
      {
        notificationId: NOTIFICATION_ID,
        deliveredTokens:
          attempt.status === "sent" ? attempt.deliveredTokens : [],
      },
      second.deps,
    );
    expect(second.sent.map(({ token }) => token)).toEqual([throttled.token]);
    expect(retry).toMatchObject({
      status: "sent",
      deliveredTokens: [reached.token, throttled.token],
      retryable: 0,
    });
  });

  test("a refusal a retry would not change is reported, not retried", async () => {
    const { deps, removed } = harness({
      answers: new Map<string, ApnsOutcome>([
        [
          device(1).token,
          { type: "rejected", reason: "PayloadTooLarge", status: 413 },
        ],
      ]),
    });

    expect(
      await deliverPushNotification({ notificationId: NOTIFICATION_ID }, deps),
    ).toEqual({
      status: "sent",
      deliveredTokens: [],
      removed: 0,
      retryable: 0,
      rejected: [{ reason: "PayloadTooLarge", status: 413 }],
    });
    expect(removed).toEqual([[]]);
  });

  test("nothing is sent for a notification that is gone, read, or out of reach", async () => {
    for (const [setup, reason] of [
      [{ owner: null }, "not_found"],
      [{ visible: false }, "not_unread"],
      [{ devices: [] }, "no_devices"],
    ] as const) {
      const { deps, sent } = harness(setup);
      expect(
        await deliverPushNotification(
          { notificationId: NOTIFICATION_ID },
          deps,
        ),
      ).toEqual({ status: "skipped", reason });
      expect(sent).toEqual([]);
    }
  });

  test("a job whose id is not a notification id reads nothing", async () => {
    const { deps, sent } = harness();
    let read = false;
    const result = await deliverPushNotification(
      { notificationId: "'; DROP TABLE notifications; --" },
      {
        ...deps,
        readRecipient: async () => {
          read = true;
          return await Promise.resolve(recipient);
        },
      },
    );
    expect(result).toEqual({ status: "skipped", reason: "invalid_job" });
    expect(read).toBe(false);
    expect(sent).toEqual([]);
  });
});
