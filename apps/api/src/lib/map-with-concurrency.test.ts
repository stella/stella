import { expect, test } from "bun:test";

import {
  createConcurrencyLimiter,
  mapWithConcurrency,
} from "@/api/lib/map-with-concurrency";

test("maps in order without exceeding the concurrency limit", async () => {
  let active = 0;
  let maximumActive = 0;

  const values = await mapWithConcurrency({
    items: [3, 1, 2, 0],
    limit: 2,
    operation: async (value, index) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Bun.sleep(value);
      active -= 1;
      return `${String(index)}:${String(value)}`;
    },
  });

  expect(values).toEqual(["0:3", "1:1", "2:2", "3:0"]);
  expect(maximumActive).toBe(2);
});

test("shares a FIFO concurrency limit across independent callers", async () => {
  const limit = createConcurrencyLimiter(2);
  const started: number[] = [];
  let active = 0;
  let maximumActive = 0;

  await Promise.all(
    [0, 1, 2, 3, 4, 5].map(
      async (value) =>
        await limit(async () => {
          started.push(value);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await Bun.sleep(1);
          active -= 1;
        }),
    ),
  );

  expect(started).toEqual([0, 1, 2, 3, 4, 5]);
  expect(maximumActive).toBe(2);
});
