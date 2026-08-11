import { expect, test } from "bun:test";

import { mapWithConcurrency } from "@/api/lib/map-with-concurrency";

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
