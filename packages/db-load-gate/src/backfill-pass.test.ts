import { TaggedError } from "better-result";
import { expect, test } from "bun:test";

import { runBackfillPass } from "./backfill-pass";

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
    await expect(pass).rejects.toBe(failure);
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
