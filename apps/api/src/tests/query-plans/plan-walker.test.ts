import { panic } from "better-result";
import { expect, test } from "bun:test";

import {
  accessPathViolations,
  explainRoot,
  heapFetchRiskViolations,
  scanOccurrences,
  withoutAuthorizationSubplans,
} from "@/api/tests/query-plans/plan-walker";
import workspaceRlsPlan from "@/api/tests/query-plans/workspace-rls-plan.fixture.json" with { type: "json" };

test("keeps repeated relation scans distinct by structural position", () => {
  const root = explainRoot([
    {
      "QUERY PLAN": [
        {
          Plan: {
            "Node Type": "Append",
            Plans: [
              {
                "Node Type": "Index Only Scan",
                "Relation Name": "case_law_decisions",
                Alias: "first",
                "Index Name": "case_law_decisions_ecli_idx",
                "Index Cond": "(ecli = 'x')",
                "Plan Rows": 1,
              },
              {
                "Node Type": "Index Scan",
                "Relation Name": "case_law_decisions",
                Alias: "second",
                "Index Name": "case_law_decisions_pkey",
                "Index Cond": "(id = 'x')",
                "Plan Rows": 1,
              },
            ],
          },
        },
      ],
    },
  ]);
  const scans = scanOccurrences(root);
  expect(scans.map(({ position, alias }) => [position, alias])).toEqual([
    ["root/0", "first"],
    ["root/1", "second"],
  ]);
  expect(scans.map(({ rows }) => rows)).toEqual([1, 1]);
  expect(scans.map(({ index }) => index)).toEqual([
    "case_law_decisions_ecli_idx",
    "case_law_decisions_pkey",
  ]);
  expect(
    accessPathViolations(
      scans,
      scans.map(({ position, relation, nodeType, index }) => ({
        position,
        relation,
        nodeType,
        index,
      })),
      "point",
      false,
    ),
  ).toEqual([]);
  expect(
    accessPathViolations(
      scans,
      [
        {
          occurrence: 0,
          relation: "case_law_decisions",
          nodeType: "Index Only Scan",
          index: "case_law_decisions_ecli_idx",
        },
        {
          occurrence: 1,
          relation: "case_law_decisions",
          nodeType: "Index Scan",
          index: "case_law_decisions_pkey",
        },
      ],
      "point",
      false,
    ),
  ).toEqual([]);
  expect(
    accessPathViolations(
      scans,
      [
        {
          position: "root/0",
          relation: "case_law_decisions",
          nodeType: "Index Scan",
          index: "other_idx",
        },
        {
          position: "root/1",
          relation: "case_law_decisions",
          nodeType: "Index Scan",
          index: "case_law_decisions_pkey",
        },
      ],
      "point",
      false,
    ),
  ).toContain(
    "root/0: expected Index Scan/other_idx, got Index Only Scan/case_law_decisions_ecli_idx on case_law_decisions",
  );
});

const coveringScan = (extra: Record<string, unknown> = {}) => ({
  "Node Type": "Index Only Scan",
  "Relation Name": "case_law_decisions",
  "Index Name": "case_law_decisions_sitemap_shard_idx",
  ...extra,
});

test("recognizes a LIMIT directly above a covering scan", () => {
  const scans = scanOccurrences({
    "Node Type": "Limit",
    "Plan Rows": 50,
    Plans: [coveringScan()],
  });
  expect(scans[0]?.limitAbove).toBe(true);
  expect(scans[0]?.limitRows).toBe(50);
  expect(heapFetchRiskViolations(scans, "page")).toEqual([]);
});

test("a LIMIT does not bound scans beneath a blocking node", () => {
  for (const blocking of [
    "Aggregate",
    "Sort",
    "Incremental Sort",
    "Hash",
    "Materialize",
    "WindowAgg",
    "Unique",
    "SetOp",
    "ProjectSet",
  ]) {
    const scans = scanOccurrences({
      "Node Type": "Limit",
      "Plan Rows": 5,
      Plans: [{ "Node Type": blocking, Plans: [coveringScan()] }],
    });
    expect([blocking, scans[0]?.limitAbove]).toEqual([blocking, false]);
    expect(heapFetchRiskViolations(scans, "aggregate")).toEqual([
      "root/0/0: heap-fetch risk on case_law_decisions: declare one mitigation",
    ]);
  }
});

test("a LIMIT reaches a covering scan through streaming nodes only", () => {
  const scans = scanOccurrences({
    "Node Type": "Limit",
    "Plan Rows": 5,
    Plans: [
      {
        "Node Type": "Append",
        Plans: [
          { "Node Type": "Result", Plans: [coveringScan()] },
          { "Node Type": "Subquery Scan", Plans: [coveringScan()] },
          {
            "Node Type": "Subquery Scan",
            Filter: "(rank = 1)",
            Plans: [coveringScan()],
          },
          coveringScan({ Filter: "(language = 'cs')" }),
          {
            "Node Type": "Aggregate",
            Plans: [
              {
                "Node Type": "Limit",
                "Plan Rows": 3,
                Plans: [coveringScan()],
              },
            ],
          },
        ],
      },
    ],
  });
  expect(
    scans.map(({ limitAbove, limitRows }) => [limitAbove, limitRows]),
  ).toEqual([
    [true, 5],
    [true, 5],
    [false, null],
    [false, null],
    [true, 3],
  ]);
});

test("a LIMIT bounds only the preserved outer side of a join", () => {
  const join = (joinType: string, extra: Record<string, unknown> = {}) =>
    scanOccurrences({
      "Node Type": "Limit",
      "Plan Rows": 5,
      Plans: [
        {
          "Node Type": "Nested Loop",
          "Join Type": joinType,
          ...extra,
          Plans: [
            coveringScan({ "Parent Relationship": "Outer" }),
            coveringScan({ "Parent Relationship": "Inner" }),
            coveringScan({
              "Parent Relationship": "SubPlan",
              "Subplan Name": "SubPlan 1",
            }),
          ],
        },
      ],
    }).map(({ limitAbove }) => limitAbove);
  expect(join("Left")).toEqual([true, false, false]);
  expect(join("Inner")).toEqual([false, false, false]);
  expect(join("Semi")).toEqual([false, false, false]);
  expect(join("Left", { Filter: "(b.id IS NULL)" })).toEqual([
    false,
    false,
    false,
  ]);
});

test("a batched mitigation needs the observed LIMIT within its page size", () => {
  const limited = (rows: number) =>
    scanOccurrences({
      "Node Type": "Limit",
      "Plan Rows": rows,
      Plans: [coveringScan()],
    });
  const mitigation = { type: "batched", pageSize: 100 } as const;
  expect(heapFetchRiskViolations(limited(100), "page", mitigation)).toEqual([]);
  expect(
    heapFetchRiskViolations(
      scanOccurrences(coveringScan()),
      "page",
      mitigation,
    ),
  ).toEqual([
    "root: batched mitigation but no observed LIMIT bounds case_law_decisions",
  ]);
  expect(heapFetchRiskViolations(limited(101), "page", mitigation)).toEqual([
    "root/0: LIMIT of 101 rows exceeds the batched page size 100 on case_law_decisions",
  ]);
  expect(
    heapFetchRiskViolations(
      scanOccurrences({
        "Node Type": "Limit",
        "Plan Rows": 10,
        Plans: [{ "Node Type": "Aggregate", Plans: [coveringScan()] }],
      }),
      "page",
      mitigation,
    ),
  ).toEqual([
    "root/0/0: batched mitigation but no observed LIMIT bounds case_law_decisions",
  ]);
});

test("a pinned heap-fetch exception covers only its scan until it expires", () => {
  const aggregatePlan = (index: string) =>
    scanOccurrences({
      "Node Type": "Limit",
      "Plan Rows": 5,
      Plans: [
        {
          "Node Type": "Aggregate",
          Plans: [
            {
              "Node Type": "Append",
              Plans: [
                coveringScan({ "Index Name": index }),
                coveringScan({ "Index Name": "case_law_decisions_other_idx" }),
              ],
            },
          ],
        },
      ],
    });
  const exception = {
    scan: {
      position: "root/0/0/0",
      relation: "case_law_decisions",
      nodeType: "Index Only Scan",
      index: "case_law_decisions_sitemap_shard_idx",
    },
    reason: "per-row lookup under an aggregate",
    rework: "bound the query",
    expiresOn: "2026-10-13",
  };
  const onDay = (day: string) => new Date(`${day}T12:00:00Z`);
  const onlyPinned = aggregatePlan("case_law_decisions_sitemap_shard_idx");
  const pinnedScan = onlyPinned.filter(
    ({ position }) => position === "root/0/0/0",
  );

  // Matching: the pinned scan is covered on and before the expiry day.
  expect(
    heapFetchRiskViolations(
      pinnedScan,
      "aggregate",
      undefined,
      [exception],
      onDay("2026-10-13"),
    ),
  ).toEqual([]);
  // Never covers another scan of the same plan.
  expect(
    heapFetchRiskViolations(
      onlyPinned,
      "aggregate",
      undefined,
      [exception],
      onDay("2026-09-29"),
    ),
  ).toEqual([
    "root/0/0/1: heap-fetch risk on case_law_decisions: declare one mitigation",
  ]);
  // Expired: fails after the expiry day and names the rework.
  expect(
    heapFetchRiskViolations(
      pinnedScan,
      "aggregate",
      undefined,
      [exception],
      onDay("2026-10-14"),
    ),
  ).toEqual([
    "heap-fetch exception for root/0/0/0 on case_law_decisions expired on 2026-10-13: bound the query",
  ]);
  // Stale: the plan changed, so the exception must be removed.
  const stale =
    "heap-fetch exception for root/0/0/0 on case_law_decisions is stale: the plan has no such risky Index Only Scan/case_law_decisions_sitemap_shard_idx; remove it";
  expect(
    heapFetchRiskViolations(
      aggregatePlan("case_law_decisions_changed_idx").filter(
        ({ position }) => position === "root/0/0/0",
      ),
      "aggregate",
      undefined,
      [exception],
      onDay("2026-09-29"),
    ),
  ).toEqual([
    stale,
    "root/0/0/0: heap-fetch risk on case_law_decisions: declare one mitigation",
  ]);
  expect(
    heapFetchRiskViolations(
      scanOccurrences({
        "Node Type": "Limit",
        "Plan Rows": 5,
        Plans: [{ "Node Type": "Append", Plans: [coveringScan()] }],
      }),
      "aggregate",
      undefined,
      [{ ...exception, scan: { ...exception.scan, position: "root/0/0" } }],
      onDay("2026-09-29"),
    ),
  ).toEqual([stale.replace("root/0/0/0", "root/0/0")]);
  // Declared twice, or without a rework or a real date.
  expect(
    heapFetchRiskViolations(
      pinnedScan,
      "aggregate",
      undefined,
      [exception, exception, { ...exception, rework: " " }],
      onDay("2026-09-29"),
    ),
  ).toEqual([
    "heap-fetch exception for root/0/0/0 on case_law_decisions is declared twice",
    "heap-fetch exception for root/0/0/0 on case_law_decisions needs a reason, a rework and an expiry date",
  ]);
});

test("flags an unbounded covering scan but leaves an Index Scan alone", () => {
  const scans = scanOccurrences({
    "Node Type": "Append",
    Plans: [
      {
        "Node Type": "Index Only Scan",
        "Relation Name": "case_law_decisions",
        "Index Name": "case_law_decisions_sitemap_shard_idx",
      },
      {
        "Node Type": "Index Scan",
        "Relation Name": "case_law_decisions",
        "Index Name": "case_law_decisions_pkey",
      },
    ],
  });
  expect(scans.map(({ limitAbove }) => limitAbove)).toEqual([false, false]);
  expect(heapFetchRiskViolations(scans, "aggregate")).toEqual([
    "root/0: heap-fetch risk on case_law_decisions: declare one mitigation",
  ]);
  expect(heapFetchRiskViolations(scans, "point")).toEqual([]);
  expect(
    heapFetchRiskViolations(scans, "aggregate", {
      type: "heapFetchBudget",
      rows: 100,
      reason: "bounded source",
    }),
  ).toEqual([]);
  expect(
    heapFetchRiskViolations(
      [
        ...scans,
        ...scanOccurrences({
          "Node Type": "Seq Scan",
          "Relation Name": "statute_sitemap_shards",
        }),
      ],
      "aggregate",
      { type: "snapshot", relation: "statute_sitemap_shards" },
    ),
  ).toEqual(["root/0: snapshot mitigation does not cover case_law_decisions"]);
});

test("uses bitmap child index conditions for the heap scan", () => {
  const scans = scanOccurrences({
    "Node Type": "Bitmap Heap Scan",
    "Relation Name": "case_law_decisions",
    Filter: "(flag OR (hashed SubPlan 1))",
    Plans: [
      {
        "Node Type": "Bitmap Index Scan",
        "Index Name": "case_law_decisions_ecli_idx",
        "Index Cond": "(ecli = 'x')",
      },
      {
        "Node Type": "Hash",
        "Parent Relationship": "SubPlan",
        Plans: [
          {
            "Node Type": "Bitmap Index Scan",
            "Index Name": "unrelated_subplan_idx",
          },
        ],
      },
      {
        "Node Type": "Result",
        "Parent Relationship": "InitPlan",
        Plans: [
          {
            "Node Type": "Bitmap Index Scan",
            "Index Name": "unrelated_initplan_idx",
          },
        ],
      },
    ],
  });
  expect(scans[0]?.index).toBe("case_law_decisions_ecli_idx");
  expect(scans[0]?.indexCond).toBe("(ecli = 'x')");
  expect(
    accessPathViolations(
      scans,
      [
        {
          position: "root",
          relation: "case_law_decisions",
          nodeType: "Bitmap Heap Scan",
          index: "case_law_decisions_ecli_idx",
        },
      ],
      "point",
      false,
    ),
  ).toContain("root: OR with a subplan");
});

test("rejects residual subplans without an index condition", () => {
  const scans = scanOccurrences({
    "Node Type": "Seq Scan",
    "Relation Name": "case_law_decisions",
    Filter: "(ecli = 'x' OR (hashed SubPlan 1))",
  });
  const violations = accessPathViolations(
    scans,
    [
      {
        position: "root",
        relation: "case_law_decisions",
        nodeType: "Seq Scan",
        index: null,
      },
    ],
    "point",
    false,
  );
  expect(violations).toContain("root: Seq Scan on case_law_decisions");
  expect(violations).toContain("root: OR with a subplan");
  expect(violations).toContain(
    "root: residual subplan without index condition",
  );
});

test("does not merge separate OR and subplan predicates", () => {
  const scans = scanOccurrences({
    "Node Type": "Index Scan",
    "Relation Name": "case_law_decisions",
    Alias: "case_law_decisions",
    "Index Name": "case_law_decisions_country_date_idx",
    "Index Cond": "(country = 'CZE')",
    Filter: "(((language = 'cs') OR (language = 'en')) AND (hashed SubPlan 1))",
  });
  expect(
    accessPathViolations(
      scans,
      [
        {
          alias: "case_law_decisions",
          relation: "case_law_decisions",
          nodeType: "Index Scan",
          index: "case_law_decisions_country_date_idx",
        },
      ],
      "page",
      false,
    ),
  ).toEqual([]);
});

test("excludes only the real workspace authorization subplan", () => {
  const scan = scanOccurrences(workspaceRlsPlan).at(0);
  expect(scan?.relation).toBe("entities");
  expect(scan?.filter).toContain("SubPlan 3");
  expect(scan?.subplans[0]?.relations).toContain("aw");
  if (scan === undefined) {
    panic("Workspace RLS fixture has no scan");
  }
  expect(withoutAuthorizationSubplans(scan)).not.toContain("SubPlan 3");
  const otherSubplan = {
    ...scan,
    filter: `${scan.filter ?? ""} AND (hashed SubPlan 30)`,
  };
  expect(withoutAuthorizationSubplans(otherSubplan)).toContain("SubPlan 30");
});
