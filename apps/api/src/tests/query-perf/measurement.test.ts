import { expect, test } from "bun:test";

import { parseQueryPerfBaselineFile } from "./baseline";
import {
  budgetViolations,
  median,
  metricsFromPlan,
  shapeViolations,
} from "./measurement";

test("committed profile budgets accept their recording and reject buffer regressions independently of time", async () => {
  const baseline = parseQueryPerfBaselineFile(
    await Bun.file(new URL("baseline.json", import.meta.url)).json(),
  );
  for (const metrics of Object.values(baseline.entries)) {
    expect(budgetViolations(metrics, metrics)).toEqual([]);
    expect(
      budgetViolations(
        {
          sharedBlocks: Math.floor(metrics.sharedBlocks * 1.25) + 1,
          executionTimeMs: metrics.executionTimeMs,
        },
        metrics,
      ),
    ).toEqual([
      {
        kind: "shared-buffer-budget",
        message: `shared buffer budget exceeded: measured ${Math.floor(metrics.sharedBlocks * 1.25) + 1} > budget ${metrics.sharedBlocks * 1.25} (baseline ${metrics.sharedBlocks} × 1.25)`,
      },
    ]);
  }
});

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

test("buffer budgets reject extra work even when execution time improves", () => {
  const baseline = { sharedBlocks: 356, executionTimeMs: 7.578 };
  expect(
    budgetViolations({ sharedBlocks: 445, executionTimeMs: 1 }, baseline),
  ).toEqual([]);
  expect(
    budgetViolations({ sharedBlocks: 450, executionTimeMs: 1 }, baseline),
  ).toEqual([
    {
      kind: "shared-buffer-budget",
      message:
        "shared buffer budget exceeded: measured 450 > budget 445 (baseline 356 × 1.25)",
    },
  ]);
});

test("execution time noise above the former budget passes below the hang guard", () => {
  const baseline = { sharedBlocks: 356, executionTimeMs: 7.578 };
  for (const executionTimeMs of [15.2, 50, 500, 1000]) {
    expect(
      budgetViolations({ sharedBlocks: 356, executionTimeMs }, baseline),
    ).toEqual([]);
  }
});

test("execution time hang guard uses a floor and reports measured versus guard", () => {
  expect(
    budgetViolations(
      { sharedBlocks: 356, executionTimeMs: 1203.4 },
      { sharedBlocks: 356, executionTimeMs: 7.578 },
    ),
  ).toEqual([
    {
      kind: "execution-time-hang-guard",
      message:
        "execution time hang guard exceeded: median 1203.4 ms > guard 1000 ms (baseline 7.578 ms × 25, floor 1000 ms)",
    },
  ]);
});

test("execution time hang guard scales with slower recorded queries", () => {
  const baseline = { sharedBlocks: 100, executionTimeMs: 80 };
  expect(
    budgetViolations({ sharedBlocks: 100, executionTimeMs: 2000 }, baseline),
  ).toEqual([]);
  expect(
    budgetViolations({ sharedBlocks: 100, executionTimeMs: 2000.1 }, baseline),
  ).toEqual([
    {
      kind: "execution-time-hang-guard",
      message:
        "execution time hang guard exceeded: median 2000.1 ms > guard 2000 ms (baseline 80 ms × 25, floor 1000 ms)",
    },
  ]);
});

test("median supports odd and even samples and rejects malformed measurements", () => {
  expect(median([8, 1, 3, 2, 4])).toBe(3);
  expect(median([8, 1, 3, 2])).toBe(2.5);
  expect(() => median([])).toThrow("nonnegative finite samples");
  expect(() => metricsFromPlan({ Plan: {}, "Execution Time": 1 })).toThrow(
    "lacks finite execution time",
  );
});
