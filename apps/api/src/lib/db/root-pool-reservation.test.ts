import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { withRootPoolReservation } from "@/api/lib/db/root-pool-reservation";
import { createRootPoolWindow } from "@/api/lib/observability/root-pool-window";

const snapshot = { status: "observed", size: 1, inUse: 0, idle: 1 } as const;

test("acquisition timing excludes transaction work and releases exactly once", async () => {
  let time = 0;
  let released = 0;
  const window = createRootPoolWindow({ now: () => time, random: () => 0 });
  const result = await withRootPoolReservation({
    window,
    reserve: async () => {
      expect(window.flush(1, snapshot).waitingRequests).toBe(1);
      time = 12;
      return {
        release: () => {
          released += 1;
        },
      };
    },
    work: async () => {
      expect(window.flush(1, snapshot)).toMatchObject({
        waitingRequests: 0,
        inUseTransactions: 1,
        waitP95Ms: 12,
      });
      time = 900;
      return "completed";
    },
  });
  expect(result).toBe("completed");
  expect(released).toBe(1);
  expect(window.flush(1, snapshot).inUseTransactions).toBe(0);
});

test("reservation failure propagates and clears the queue without recording a successful wait", async () => {
  const window = createRootPoolWindow({ now: () => 0, random: () => 0 });
  const failure = new TypeError("connection unavailable");
  const result = await rejectionOf(
    withRootPoolReservation({
      window,
      reserve: async () => {
        throw failure;
      },
      work: async () => {
        throw new TypeError("work must not start");
      },
    }),
  );
  expect(result).toBe(failure);
  expect(window.flush(1, snapshot)).toMatchObject({
    waitingRequests: 0,
    inUseTransactions: 0,
    acquisitionFailures: 1,
    waitSamples: 0,
    waitP95Ms: null,
  });
});

test("work failure propagates after releasing the reserved session", async () => {
  let released = 0;
  const window = createRootPoolWindow({ now: () => 0, random: () => 0 });
  const failure = new TypeError("work failed");
  const result = await rejectionOf(
    withRootPoolReservation({
      window,
      reserve: async () => ({
        release: () => {
          released += 1;
        },
      }),
      work: async () => {
        throw failure;
      },
    }),
  );
  expect(result).toBe(failure);
  expect(released).toBe(1);
  expect(window.flush(1, snapshot)).toMatchObject({
    waitingRequests: 0,
    inUseTransactions: 0,
    acquisitionFailures: 0,
    waitSamples: 1,
    waitMaxMs: 0,
  });
});
