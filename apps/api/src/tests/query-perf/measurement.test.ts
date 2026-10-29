import { expect, test } from "bun:test";

import { READ_BUDGETS } from "@/api/lib/db/read-budgets";

import {
  budgetProblem,
  budgetViolations,
  median,
  metricsFromPlan,
  scaleViolations,
  shapeViolations,
  sumMetrics,
} from "./measurement";
import { analyzePlan } from "./plan-analyzer";
import { PLAN_EXCEPTIONS } from "./plan-exceptions";

const plan = (Plan: Record<string, unknown>, executionTime = 1) => ({
  Plan,
  "Execution Time": executionTime,
});

test("a sequential scan on a large table fails while a declared small table passes", () => {
  expect(
    analyzePlan({
      document: plan({ "Node Type": "Seq Scan", "Relation Name": "entities" }),
      owner: "statement.owner",
      statement: "select * from entities",
    }).map(({ kind }) => kind),
  ).toEqual(["large-scan"]);
  expect(
    analyzePlan({
      document: plan({
        "Node Type": "Seq Scan",
        "Relation Name": "legislation_sources",
      }),
      owner: "statement.owner",
      statement: "select * from legislation_sources",
    }),
  ).toEqual([]);
});

test("an unbounded nested-loop outer side fails while a limit-bound side passes", () => {
  const analyzeOuter = (outer: Record<string, unknown>) =>
    analyzePlan({
      document: plan({
        "Node Type": "Nested Loop",
        Plans: [
          outer,
          { "Node Type": "Index Scan", "Relation Name": "entities" },
        ],
      }),
      owner: "statement.owner",
      statement: "select joined rows",
    }).map(({ kind }) => kind);
  expect(analyzeOuter({ "Node Type": "Result", "Actual Rows": 1001 })).toEqual([
    "unbounded-nested-loop",
  ]);
  expect(
    analyzeOuter({
      "Node Type": "Limit",
      "Actual Rows": 1001,
      Plans: [{ "Node Type": "Result" }],
    }),
  ).toEqual([]);
});

test("an external sort fails the spill rule", () => {
  expect(
    analyzePlan({
      document: plan({ "Node Type": "Sort", "Sort Method": "external merge" }),
      owner: "statement.owner",
      statement: "select ordered rows",
    }).map(({ kind }) => kind),
  ).toEqual(["spill"]);
});

test("scaled execution time over the statement timeout share fails", () => {
  expect(
    analyzePlan({
      document: plan({ "Node Type": "Result" }, 76),
      owner: "statement.owner",
      statement: "select 1",
    }).map(({ kind }) => kind),
  ).toEqual(["scaled-time"]);
});

test("the owner-named plan exception ledger only contains reviewed existing debt", () => {
  expect(
    PLAN_EXCEPTIONS.map(
      ({ kind, owner, relation }) => `${owner}:${kind}:${relation}`,
    ).toSorted(),
  ).toEqual([
    "statement.documents.searchHits:large-scan:entities",
    "statement.documents.searchHits:large-scan:entity_versions",
    "statement.documents.searchHits:large-scan:member",
    "statement.documents.searchHits:large-scan:search_documents",
    "statement.documents.searchHits:large-scan:workspace_members",
    "statement.documents.searchHits:large-scan:workspaces",
  ]);
  expect(PLAN_EXCEPTIONS.every(({ reason }) => reason.length > 0)).toBe(true);
});

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

test("scheduled runs retain execution time and reject a slow statement within the page budget", () => {
  const id = "scheduled.caseLaw.reportFreshness";
  for (const statements of [
    [{ sharedBlocks: 1, executionTimeMs: 10_001 }],
    [
      { sharedBlocks: 1, executionTimeMs: 5000 },
      { sharedBlocks: 2, executionTimeMs: 5001 },
    ],
  ]) {
    const metrics = sumMetrics(statements);
    expect(metrics.sharedBlocks).toBeLessThan(READ_BUDGETS[id].pages);
    expect(metrics.executionTimeMs).toBe(10_001);
    expect(budgetProblem(id, metrics)).toContain(
      "execution time hang guard exceeded",
    );
  }
  expect(
    budgetProblem(
      id,
      sumMetrics([{ sharedBlocks: 1, executionTimeMs: 10_000 }]),
    ),
  ).toBeUndefined();
});
