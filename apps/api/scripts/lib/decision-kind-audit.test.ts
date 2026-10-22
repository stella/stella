import { expect, test } from "bun:test";

import {
  auditDecisionKinds,
  type DecisionKindAuditRow,
} from "./decision-kind-audit";

const row = {
  id: "fixture",
  source: "publisher-a",
  court: "Nejvyšší soud",
  ecli: "ECLI:CZ:NS:2026:1.CDO.1.2026.1",
  stated: "usn.",
  headings: ["USNESENÍ"],
} satisfies DecisionKindAuditRow;

test.each([
  ["ROZSUDEK JMÉNEM REPUBLIKY", "judgment"],
  ["Rozsudok", "judgment"],
  ["USNESENÍ", "order"],
  ["Uznesenie", "order"],
  ["NÁLEZ", "finding"],
  ["TRESTNÝ ROZKAZ V MENE", "penal_order"],
] as const)("audit reads own title %s as %s", (heading, kind) => {
  const report = auditDecisionKinds({
    vocabulary: {},
    rows: [{ ...row, stated: null, headings: [heading] }],
  });
  expect(report.conflicts.map(({ headingKind }) => headingKind)).toEqual([
    kind,
  ]);
});

test("audit reports missing values and conflicting own headings without reading body citations", () => {
  const result = auditDecisionKinds({
    vocabulary: { CZE: ["new-form", "usn."] },
    rows: [
      row,
      { ...row, id: "conflict", stated: "rozsudek" },
      { ...row, id: "missing", stated: null, headings: [] },
      { ...row, id: "quoted", headings: ["Odůvodnění: rozsudek soudu"] },
    ],
  });
  expect(result.missing).toEqual([
    { source: "CZE", stated: "new-form", id: null },
    { source: row.source, stated: null, id: "missing" },
  ]);
  expect(result.conflicts).toEqual([
    {
      id: "conflict",
      source: row.source,
      court: "CZ:NS",
      stated: "rozsudek",
      mapped: "judgment",
      headingKind: "order",
    },
  ]);
});

test("audit compares kind shares within the same ECLI court across sources, including absent kinds", () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    ...row,
    id: String(index),
  }));
  const other = rows.map((item) => ({
    ...item,
    court: "Supreme Court",
    source: "publisher-b",
    stated: "rozsudek",
    headings: ["ROZSUDEK"],
  }));
  const result = auditDecisionKinds({
    vocabulary: {},
    rows: [...rows, ...other],
  });
  expect(result.shareJumps.map(({ kind }) => kind).toSorted()).toEqual([
    "judgment",
    "order",
  ]);
  expect(result.shareJumps.at(0)?.sources.map(({ total }) => total)).toEqual([
    20, 20,
  ]);
  expect(
    auditDecisionKinds({ vocabulary: {}, rows: [...rows, ...other.slice(1)] })
      .shareJumps,
  ).toEqual([]);
  expect(
    auditDecisionKinds({
      vocabulary: {},
      rows: [
        ...rows,
        ...other.map((item) => ({
          ...item,
          ecli: "ECLI:CZ:NSS:2026:1.AS.1.2026.1",
        })),
      ],
    }).shareJumps,
  ).toEqual([]);
});
