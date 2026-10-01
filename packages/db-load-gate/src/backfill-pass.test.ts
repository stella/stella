import { TaggedError } from "better-result";
import { expect, test } from "bun:test";

import { BackfillHeldError, runBackfillPass } from "./backfill-pass";

class DeferredPassError extends TaggedError("DeferredPassError")<{
  message: string;
}> {}

test("committed batches are observed and paced before the next step; completion never sleeps", async () => {
  const events: string[] = [];
  let batchNumber = 0;
  await runBackfillPass({
    step: async () => {
      const value = ++batchNumber;
      events.push(`step:${value}`);
      return { value, done: value === 3, sleepMs: value * 10 };
    },
    onBatch: ({ value }) => {
      events.push(`batch:${value}`);
    },
    sleep: async (milliseconds) => {
      events.push(`sleep:${milliseconds}`);
    },
  });
  expect(events).toEqual([
    "step:1",
    "batch:1",
    "sleep:10",
    "step:2",
    "batch:2",
    "sleep:20",
    "step:3",
    "batch:3",
  ]);
});

test("an unfinished zero-delay batch advances without calling the sleep adapter", async () => {
  const values: number[] = [];
  let steps = 0;
  let sleeps = 0;
  await runBackfillPass({
    step: async () => ({ value: ++steps, done: steps === 2, sleepMs: 0 }),
    onBatch: ({ value }) => {
      values.push(value);
    },
    sleep: async () => {
      sleeps++;
    },
  });
  expect(values).toEqual([1, 2]);
  expect(sleeps).toBe(0);
});

for (const failureAt of ["step", "observer", "sleep"] as const) {
  test(`a ${failureAt} failure propagates and starts no further batch`, async () => {
    const failure = new DeferredPassError({
      message: `deferred at ${failureAt}`,
    });
    let steps = 0;
    const pass = runBackfillPass({
      step: async () => {
        steps++;
        if (failureAt === "step") {
          throw failure;
        }
        return { value: steps, done: false, sleepMs: 10 };
      },
      onBatch: () => {
        if (failureAt === "observer") {
          throw failure;
        }
      },
      sleep: async () => {
        if (failureAt === "sleep") {
          throw failure;
        }
      },
    });
    const result = await pass;
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBe(failure);
    }
    expect(steps).toBe(1);
  });
}

test("the next step waits for the injected observer and sleep barriers", async () => {
  const observerEntered = Promise.withResolvers<undefined>();
  const releaseObserver = Promise.withResolvers<undefined>();
  const sleepEntered = Promise.withResolvers<undefined>();
  const releaseSleep = Promise.withResolvers<undefined>();
  let steps = 0;
  const pass = runBackfillPass({
    step: async () => ({ value: ++steps, done: steps === 2, sleepMs: 1 }),
    onBatch: async ({ done }) => {
      if (done) {
        return;
      }
      observerEntered.resolve(undefined);
      await releaseObserver.promise;
    },
    sleep: async () => {
      sleepEntered.resolve(undefined);
      await releaseSleep.promise;
    },
  });
  await observerEntered.promise;
  expect(steps).toBe(1);
  releaseObserver.resolve(undefined);
  await sleepEntered.promise;
  expect(steps).toBe(1);
  releaseSleep.resolve(undefined);
  await pass;
  expect(steps).toBe(2);
});

test("a pass without an observer still advances each committed batch", async () => {
  let steps = 0;
  let paced = 0;
  await runBackfillPass({
    step: async () => ({ value: ++steps, done: steps === 2, sleepMs: 7 }),
    sleep: async (milliseconds) => {
      paced += milliseconds;
    },
  });
  expect(steps).toBe(2);
  expect(paced).toBe(7);
});

for (const reason of ["hold", "retry"] as const) {
  test(`${reason} waits with logged numbers then resumes the same checkpoint`, async () => {
    let now = 100;
    let attempts = 0;
    let checkpoint = "saved-cursor";
    const waits: number[] = [];
    const records: unknown[] = [];
    const result = await runBackfillPass({
      clock: () => now,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
      log: (record) => {
        records.push(record);
      },
      step: async () => {
        attempts++;
        if (attempts === 1) {
          throw new BackfillHeldError({
            message: "deferred",
            holdUntil: reason === "hold" ? 5100 : null,
            heldSince: reason === "hold" ? 100 : null,
          });
        }
        expect(checkpoint).toBe("saved-cursor");
        checkpoint = "finished";
        return { done: true, sleepMs: 0, value: checkpoint };
      },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe("complete");
    }
    expect(attempts).toBe(2);
    expect(waits).toEqual([reason === "hold" ? 5000 : 1000]);
    expect(records).toEqual([
      expect.objectContaining({
        action: "wait",
        reason,
        now: 100,
        sleepMs: waits.at(0),
        waitedMs: 0,
        maxWaitMs: null,
      }),
    ]);
    expect(checkpoint).toBe("finished");
  });
}

test("a maximum wait exits cleanly with resume instructions and leaves the checkpoint intact", async () => {
  let now = 0;
  const checkpoint = { cursor: "saved", writes: 7 };
  const records: { action: string; message: string }[] = [];
  let attempts = 0;
  const result = await runBackfillPass({
    maxWaitMs: 1500,
    clock: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    log: (record) => {
      records.push(record);
    },
    step: async () => {
      attempts++;
      throw new BackfillHeldError({
        message: "retry",
        holdUntil: null,
        heldSince: null,
      });
    },
  });
  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value).toEqual({
      status: "paused",
      holdUntil: null,
      waitedMs: 1000,
    });
  }
  expect(attempts).toBe(2);
  expect(checkpoint).toEqual({ cursor: "saved", writes: 7 });
  expect(records.map(({ action }) => action)).toEqual(["wait", "paused"]);
  expect(records.at(-1)?.message).toContain("rerun the same command to resume");
});

test("a hold beyond the caller's wait budget exits before sleeping or stepping again", async () => {
  let sleeps = 0;
  const records: unknown[] = [];
  const result = await runBackfillPass({
    maxWaitMs: 10,
    clock: () => 0,
    sleep: async () => {
      sleeps++;
    },
    log: (record) => {
      records.push(record);
    },
    step: async () => {
      throw new BackfillHeldError({
        message: "held",
        holdUntil: 100,
        heldSince: 0,
      });
    },
  });
  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value).toEqual({
      status: "paused",
      holdUntil: 100,
      waitedMs: 0,
    });
  }
  expect(sleeps).toBe(0);
  expect(records).toEqual([
    expect.objectContaining({ action: "paused", reason: "hold", sleepMs: 100 }),
  ]);
});

for (const reason of ["hold", "retry"] as const) {
  test(`online ${reason} propagates without waiting or advancing another batch`, async () => {
    const failure = new BackfillHeldError({
      message: "repair pending",
      holdUntil: reason === "hold" ? 5100 : null,
      heldSince: reason === "hold" ? 100 : null,
    });
    let attempts = 0;
    let sleeps = 0;
    const result = await runBackfillPass({
      holdPolicy: "propagate",
      clock: () => 100,
      step: async () => {
        attempts++;
        throw failure;
      },
      sleep: async () => {
        sleeps++;
        throw new DeferredPassError({ message: "online repair must defer" });
      },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBe(failure);
    }
    expect(attempts).toBe(1);
    expect(sleeps).toBe(0);
  });
}
