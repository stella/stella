import { expect, test } from "bun:test";

import { collectSeparateNavigationMeasurements } from "../agent/drive-measure";

test("depth collection never installs a hold on the performance navigation", async () => {
  let requestHoldInstalled = false;
  const measurements = await collectSeparateNavigationMeasurements({
    collectPerformance: async () => {
      expect(requestHoldInstalled).toBe(false);
      return { largestContentfulPaintMs: 120, settledMs: 450 };
    },
    collectDepth: async () => {
      requestHoldInstalled = true;
      return 3;
    },
  });

  expect(measurements).toEqual({
    depth: 3,
    performance: { largestContentfulPaintMs: 120, settledMs: 450 },
  });
});
