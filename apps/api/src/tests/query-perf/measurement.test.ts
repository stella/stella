import { expect, test } from "bun:test";

import { READ_BUDGETS } from "@/api/lib/db/read-budgets";

import {
  budgetProblem,
  budgetViolations,
  median,
  metricsFromPlan,
  scaleViolations,
  shapeViolations,
  summarize,
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
      ownerDeadlineMs: 30_000,
      profileId: "small",
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
      ownerDeadlineMs: 30_000,
      profileId: "small",
      statement: "select * from legislation_sources",
    }),
  ).toEqual([]);
});

test("a lossy bitmap heap scan fails even without rows removed by recheck", () => {
  expect(
    analyzePlan({
      document: plan({
        "Node Type": "Bitmap Heap Scan",
        "Relation Name": "entities",
        "Lossy Heap Blocks": 1,
        "Rows Removed by Index Recheck": 0,
      }),
      owner: "statement.owner",
      ownerDeadlineMs: 30_000,
      profileId: "small",
      statement: "select * from entities",
    }).map(({ kind }) => kind),
  ).toEqual(["large-scan"]);
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
      ownerDeadlineMs: 30_000,
      profileId: "small",
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
  expect(
    analyzeOuter({
      "Node Type": "Append",
      "Actual Rows": 1001,
      Plans: [
        { "Node Type": "Limit", Plans: [{ "Node Type": "Result" }] },
        { "Node Type": "Result" },
      ],
    }),
  ).toEqual(["unbounded-nested-loop"]);
  expect(
    analyzeOuter({
      "Node Type": "Hash Join",
      "Actual Rows": 1001,
      Plans: [
        {
          "Node Type": "Index Scan",
          "Index Cond": "(id > 1)",
        },
        { "Node Type": "Hash" },
      ],
    }),
  ).toEqual(["unbounded-nested-loop"]);
});

test("an external sort fails the spill rule", () => {
  expect(
    analyzePlan({
      document: plan({ "Node Type": "Sort", "Sort Method": "external merge" }),
      owner: "statement.owner",
      ownerDeadlineMs: 30_000,
      profileId: "small",
      statement: "select ordered rows",
    }).map(({ kind }) => kind),
  ).toEqual(["spill"]);
});

test("a hashed aggregate that uses multiple batches or disk fails the spill rule", () => {
  for (const spill of [{ "HashAgg Batches": 2 }, { "Disk Usage": 1 }]) {
    expect(
      analyzePlan({
        document: plan({
          "Node Type": "Aggregate",
          Strategy: "Hashed",
          ...spill,
        }),
        owner: "statement.owner",
        ownerDeadlineMs: 30_000,
        profileId: "small",
        statement: "select grouped rows",
      }).map(({ kind }) => kind),
    ).toEqual(["spill"]);
  }
});

test("every execution plan contributes findings, including an earlier execution", () => {
  const result = summarize(
    [
      { sharedBlocks: 1, executionTimeMs: 1 },
      { sharedBlocks: 1, executionTimeMs: 1 },
    ],
    [
      plan({ "Node Type": "Seq Scan", "Relation Name": "entities" }),
      plan({ "Node Type": "Index Scan", "Relation Name": "entities" }),
    ],
    "statement.owner",
    30_000,
    "select * from entities",
    "growth",
  );
  expect(result.planViolations.map(({ kind }) => kind)).toEqual(["large-scan"]);
});

test("a plan exception recorded for one profile does not hide another profile", () => {
  expect(
    analyzePlan({
      document: plan({
        "Node Type": "Seq Scan",
        "Relation Name": "search_documents",
      }),
      owner: "statement.documents.searchHits",
      ownerDeadlineMs: 30_000,
      profileId: "growth",
      statement: "select * from search_documents",
    }).map(({ kind }) => kind),
  ).toEqual(["large-scan"]);
});

test("scaled execution time is checked against the owner's deadline", () => {
  expect(
    analyzePlan({
      document: plan({ "Node Type": "Result" }, 20),
      owner: "statement.owner",
      ownerDeadlineMs: 5000,
      profileId: "small",
      statement: "select 1",
    }).map(({ kind }) => kind),
  ).toEqual(["scaled-time"]);
});

test("an owner without a statement deadline yields a typed finding", () => {
  expect(
    analyzePlan({
      document: plan({ "Node Type": "Result" }),
      owner: "statement.withoutDeadline",
      ownerDeadlineMs: undefined,
      profileId: "small",
      statement: "select 1",
    }).map(({ kind }) => kind),
  ).toEqual(["deadline-missing"]);
});

test("the owner-named plan exception ledger only contains reviewed existing debt", () => {
  expect(
    PLAN_EXCEPTIONS.map(
      ({ kind, owner, profileId, ...entry }) =>
        `${profileId}:${owner}:${kind}:${"relation" in entry ? entry.relation : "owner"}`,
    ).toSorted(),
  ).toEqual([
    "corpus:caseLaw.reportFreshness.fiveMinute:deadline-missing:owner",
    "growth:statement.documents.searchHits:deadline-missing:owner",
    "growth:statement.documents.searchHits:large-scan:member",
    "growth:statement.documents.searchHits:large-scan:workspace_members",
    "growth:statement.documents.searchHits:large-scan:workspaces",
    "small:statement.documents.searchHits:deadline-missing:owner",
    "small:statement.documents.searchHits:large-scan:entities",
    "small:statement.documents.searchHits:large-scan:entity_versions",
    "small:statement.documents.searchHits:large-scan:member",
    "small:statement.documents.searchHits:large-scan:search_documents",
    "small:statement.documents.searchHits:large-scan:workspace_members",
    "small:statement.documents.searchHits:large-scan:workspaces",
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
