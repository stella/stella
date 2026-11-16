import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";

import {
  drainReactScheduler,
  loadReactScheduler,
  unregisterDomEnvironment,
} from "./dom-environment";

const domGlobals = () =>
  `${String("window" in globalThis)}:${String("document" in globalThis)}`;

test("teardown runs queued React work while the DOM globals still exist, then removes them", async () => {
  GlobalRegistrator.register();
  const scheduler = loadReactScheduler();
  const seen: string[] = [];
  // A passive effect left behind by a commit outside act() that reads the DOM.
  scheduler.unstable_scheduleCallback(scheduler.unstable_NormalPriority, () => {
    seen.push(domGlobals());
    // Idle work a promise continuation leaves behind expires after any
    // barrier already queued.
    queueMicrotask(() => {
      scheduler.unstable_scheduleCallback(
        scheduler.unstable_IdlePriority,
        () => {
          seen.push(domGlobals());
        },
      );
    });
  });

  await unregisterDomEnvironment();

  expect(seen).toEqual(["true:true", "true:true"]);
  expect(domGlobals()).toBe("false:false");
});

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
