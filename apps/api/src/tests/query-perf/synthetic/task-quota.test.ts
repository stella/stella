import { expect, test } from "bun:test";

import { allocateTaskQuotas } from "./task-quota";

test("task quotas conserve the global count and satisfy every workspace child population", () => {
  for (let entities = 1; entities <= 20; entities++) {
    for (let taskCount = 2; taskCount <= entities * 3; taskCount++) {
      const entityCounts = [entities, entities, entities];
      const itemCounts = [1, 0, 0];
      const assigneeCounts = [0, 1, 0];
      const quotas = allocateTaskQuotas({
        entityCounts,
        itemCounts,
        assigneeCounts,
        taskCount,
      });
      expect(quotas.reduce((sum, count) => sum + count, 0)).toBe(taskCount);
      for (const [index, quota] of quotas.entries()) {
        expect(quota).toBeGreaterThanOrEqual(
          Math.max(itemCounts.at(index) ?? 0, assigneeCounts.at(index) ?? 0),
        );
        expect(quota).toBeLessThanOrEqual(entities);
      }
    }
  }
});

test("incompatible task frequencies fail before loading child rows", () => {
  expect(() =>
    allocateTaskQuotas({
      entityCounts: [10, 10],
      itemCounts: [4, 0],
      assigneeCounts: [0, 4],
      taskCount: 7,
    }),
  ).toThrow("Task kind frequency cannot accommodate task child rows");
  expect(() =>
    allocateTaskQuotas({
      entityCounts: [2],
      itemCounts: [3],
      assigneeCounts: [0],
      taskCount: 2,
    }),
  ).toThrow("Task child rows exceed workspace entity capacity");
});
