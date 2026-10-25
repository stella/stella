import { expect, test } from "bun:test";

import { READ_BUDGETS } from "@/api/lib/db/read-budgets";

import {
  budgetViolations,
  median,
  metricsFromPlan,
  scaleViolations,
  shapeViolations,
} from "./measurement";

test("an absolute budget accepts its own page count and rejects one page more", () => {
  for (const { pages } of Object.values(READ_BUDGETS)) {
    expect(
      budgetViolations({ sharedBlocks: pages, executionTimeMs: 1 }, pages),
    ).toEqual([]);
    expect(
      budgetViolations({ sharedBlocks: pages + 1, executionTimeMs: 1 }, pages),
    ).toEqual([
      {
        kind: "shared-buffer-budget",
        message: `shared buffer budget exceeded: measured ${pages + 1} > budget ${pages}`,
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
  expect(
    budgetViolations({ sharedBlocks: 1601, executionTimeMs: 0.1 }, 1600).map(
      ({ kind }) => kind,
    ),
  ).toEqual(["shared-buffer-budget"]);
});

test("execution time is only a hang guard", () => {
  for (const executionTimeMs of [15.2, 500, 10_000]) {
    expect(
      budgetViolations({ sharedBlocks: 100, executionTimeMs }, 100),
    ).toEqual([]);
  }
  expect(
    budgetViolations({ sharedBlocks: 100, executionTimeMs: 10_000.5 }, 100),
  ).toEqual([
    {
      kind: "execution-time-hang-guard",
      message: "execution time hang guard exceeded: 10000.5 ms > 10000 ms",
    },
  ]);
});

test("a run that reads the same pages at twice the corpus passes; one that grows does not", () => {
  expect(scaleViolations({ size: 10_150, double: 10_190 })).toEqual([]);
  expect(scaleViolations({ size: 20, double: 84 })).toEqual([]);
  expect(scaleViolations({ size: 5000, double: 9800 })).toEqual([
    "reads grow with the corpus: 5000 pages at one size, 9800 at twice the size (at most 5564)",
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
