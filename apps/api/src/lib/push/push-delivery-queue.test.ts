import { describe, expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  enqueuePushDeliveries,
  pushDeliveryJobId,
  schedulePushDeliveries,
} from "@/api/lib/push/push-delivery-queue";
import type { PushDeliveryQueue } from "@/api/lib/push/push-delivery-queue";

type AddedJob = Parameters<PushDeliveryQueue["addBulk"]>[0][number];

const recordingQueue = () => {
  const batches: AddedJob[][] = [];
  const queue: PushDeliveryQueue = {
    addBulk: async (jobs) => {
      batches.push(jobs);
      return await Promise.resolve([]);
    },
  };
  return { batches, queue };
};

const ids = (count: number) =>
  Array.from({ length: count }, () => createSafeId<"notification">());

describe("queueing push alerts", () => {
  test("one job per notification, identified by the notification", async () => {
    const { batches, queue } = recordingQueue();
    const [first, second] = ids(2) as [
      SafeId<"notification">,
      SafeId<"notification">,
    ];

    await enqueuePushDeliveries([first, second, first], queue);

    expect(batches).toEqual([
      [
        {
          name: "deliver",
          data: { notificationId: first },
          opts: { jobId: pushDeliveryJobId(first) },
        },
        {
          name: "deliver",
          data: { notificationId: second },
          opts: { jobId: pushDeliveryJobId(second) },
        },
      ],
    ]);
    // The same notification always maps to the same job, so a second
    // enqueue of it is a duplicate BullMQ ignores.
    expect(pushDeliveryJobId(first)).toBe(pushDeliveryJobId(first));
    expect(pushDeliveryJobId(first)).not.toBe(pushDeliveryJobId(second));
  });

  test("a firm-wide announcement is queued in bounded batches", async () => {
    const { batches, queue } = recordingQueue();

    await enqueuePushDeliveries(ids(250), queue);

    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
  });

  test("nothing is queued while push is not configured", () => {
    const enqueued: (readonly SafeId<"notification">[])[] = [];
    schedulePushDeliveries(ids(1), {
      configured: () => false,
      enqueue: async (notificationIds) => {
        enqueued.push(notificationIds);
        await Promise.resolve();
      },
    });
    expect(enqueued).toEqual([]);
  });

  test("a configured deployment queues the committed notifications", () => {
    const enqueued: (readonly SafeId<"notification">[])[] = [];
    const notificationIds = ids(2);
    schedulePushDeliveries(notificationIds, {
      configured: () => true,
      enqueue: async (queued) => {
        enqueued.push(queued);
        await Promise.resolve();
      },
    });
    expect(enqueued).toEqual([notificationIds]);
  });

  test("a queue outage never reaches the write that filed the notification", async () => {
    let attempted: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      attempted = resolve;
    });

    expect(() =>
      schedulePushDeliveries(ids(1), {
        configured: () => true,
        enqueue: async () => {
          attempted();
          return await Promise.reject(new TypeError("connection refused"));
        },
      }),
    ).not.toThrow();
    // The rejection is captured by the detached sink, not left unhandled.
    await settled;
  });
});
