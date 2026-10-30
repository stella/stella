import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects planner scan node literals in API tests", async () => {
  expect(
    await lintSingleRule(
      "no-plan-scan-node-literals",
      'expect(node.type).toBe("Bitmap Heap Scan");',
      { sourcePath: "apps/api/src/feature/plan.test.ts" },
    ),
  ).toEqual([1]);
  expect(
    await lintSingleRule(
      "no-plan-scan-node-literals",
      "expect(node.type).toBe(`Bitmap Heap Scan`);",
      { sourcePath: "apps/api/src/feature/plan.test.ts" },
    ),
  ).toEqual([1]);
  expect(
    await lintSingleRule(
      "no-plan-scan-node-literals",
      'expect(node.type).toBe("Index Scan");',
      {
        sourcePath: "apps/api/src/tests/query-plans/consumer-plan.db.test.ts",
      },
    ),
  ).toEqual([1]);
});

test("accepts helper-owned fixtures and unrelated strings", async () => {
  expect(
    await lintSingleRule(
      "no-plan-scan-node-literals",
      'const type = "Seq Scan";',
      { sourcePath: "apps/api/src/feature/plan.test.ts" },
    ),
  ).toEqual([]);
  expect(
    await lintSingleRule(
      "no-plan-scan-node-literals",
      'const type = "Index Scan";',
      {
        sourcePath: "apps/api/src/tests/query-plans/plan-walker.test.ts",
      },
    ),
  ).toEqual([]);
  expect(
    await lintSingleRule(
      "no-plan-scan-node-literals",
      'const type = "Index Scan";',
      {
        sourcePath: "apps/api/src/tests/query-plans/plan-walker.ts",
      },
    ),
  ).toEqual([]);
});
