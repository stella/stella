import { panic } from "better-result";
import { expect, test } from "bun:test";

import {
  accessPathViolations,
  explainRoot,
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
