import { expect, test } from "bun:test";

import {
  drainReactScheduler,
  loadReactScheduler,
} from "@/lib/react-scheduler-drain";

test("the drain resolves only after queued React work and the work it enqueues", async () => {
  const scheduler = loadReactScheduler();
  const ran: string[] = [];
  // The shape of React's passive-effect flush after a commit outside act().
  scheduler.unstable_scheduleCallback(scheduler.unstable_NormalPriority, () => {
    ran.push("effects");
    scheduler.unstable_scheduleCallback(
      scheduler.unstable_NormalPriority,
      () => {
        ran.push("follow-up");
      },
    );
  });

  await drainReactScheduler();

  expect(ran).toEqual(["effects", "follow-up"]);
});

test("the drain waits for idle work that queued work enqueues after the drain began", async () => {
  const scheduler = loadReactScheduler();
  const ran: string[] = [];
  scheduler.unstable_scheduleCallback(scheduler.unstable_NormalPriority, () => {
    ran.push("effects");
    // Enqueued from a promise continuation, after the scheduler slice that
    // ran the barrier, so it expires after any barrier queued so far.
    queueMicrotask(() => {
      scheduler.unstable_scheduleCallback(
        scheduler.unstable_IdlePriority,
        () => {
          ran.push("idle follow-up");
        },
      );
    });
  });

  await drainReactScheduler();

  expect(ran).toEqual(["effects", "idle follow-up"]);
});

test("the drain waits for idle work enqueued several microtask hops later, and the idle work that work enqueues", async () => {
  const scheduler = loadReactScheduler();
  const ran: string[] = [];
  const scheduleIdleFromMicrotask = (label: string, then?: () => void) => {
    queueMicrotask(() => {
      scheduler.unstable_scheduleCallback(
        scheduler.unstable_IdlePriority,
        () => {
          ran.push(label);
          then?.();
        },
      );
    });
  };
  scheduler.unstable_scheduleCallback(scheduler.unstable_NormalPriority, () => {
    ran.push("effects");
    // Two hops: the drain's own continuation runs between them.
    queueMicrotask(() => {
      scheduleIdleFromMicrotask("idle follow-up", () => {
        scheduleIdleFromMicrotask("second idle follow-up");
      });
    });
  });

  await drainReactScheduler();

  expect(ran).toEqual(["effects", "idle follow-up", "second idle follow-up"]);
});
