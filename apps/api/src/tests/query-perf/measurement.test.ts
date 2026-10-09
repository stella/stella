import { expect, test } from "bun:test";

import {
  budgetViolations,
  median,
  metricsFromPlan,
  shapeViolations,
} from "./measurement";

test("scan shape rules allow small-table scans and reject correlated policies at either scale", () => {
  const scan = { "Node Type": "Seq Scan", "Relation Name": "search_documents" };
  expect(shapeViolations({ Plan: scan }, "small")).toEqual([]);
  expect(shapeViolations({ Plan: scan }, "growth")).toEqual([
    "Seq Scan on search_documents",
  ]);
  const correlated = {
    ...scan,
    Filter: "(SubPlan 1)",
    Plans: [
      {
        "Node Type": "Index Scan",
        "Relation Name": "entities",
        "Parent Relationship": "SubPlan",
        "Subplan Name": "SubPlan 1",
      },
    ],
  };
  for (const profileId of ["small", "growth"] as const) {
    expect(shapeViolations({ Plan: correlated }, profileId)).toContain(
      "per-row policy subplan on search_documents",
    );
  }
});

test("shared buffers count the root once, including cache misses", () => {
  expect(
    metricsFromPlan({
      Plan: {
        "Shared Hit Blocks": 20,
        "Shared Read Blocks": 3,
        Plans: [{ "Shared Hit Blocks": 20 }],
      },
      "Execution Time": 2,
    }),
  ).toEqual({ sharedBlocks: 23, executionTimeMs: 2 });
});

test("budgets enforce buffer headroom independently and require both time thresholds", () => {
  const base = { sharedBlocks: 100, executionTimeMs: 2 };
  expect(
    budgetViolations({ sharedBlocks: 125, executionTimeMs: 10 }, base),
  ).toEqual([]);
  expect(
    budgetViolations({ sharedBlocks: 126, executionTimeMs: 1 }, base),
  ).toEqual(["shared buffer budget exceeded"]);
  expect(
    budgetViolations({ sharedBlocks: 100, executionTimeMs: 10.001 }, base),
  ).toEqual(["execution time budget exceeded"]);
  expect(
    budgetViolations(
      { sharedBlocks: 100, executionTimeMs: 20 },
      { sharedBlocks: 100, executionTimeMs: 10 },
    ),
  ).toEqual([]);
});

test("median supports odd and even samples and rejects malformed measurements", () => {
  expect(median([8, 1, 3, 2, 4])).toBe(3);
  expect(median([8, 1, 3, 2])).toBe(2.5);
  expect(() => median([])).toThrow("nonnegative finite samples");
  expect(() => metricsFromPlan({ Plan: {}, "Execution Time": 1 })).toThrow(
    "lacks finite execution time",
  );
});
