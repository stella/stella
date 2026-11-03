import { expect, test } from "bun:test";

import {
  auditChangeRows,
  formatAuditValue,
  formatAuditValueInline,
} from "./audit-change-details.logic";

test("field diffs become before and after rows", () => {
  expect(
    auditChangeRows({
      status: { old: "completed", new: "pending" },
      practiceJurisdictions: { old: ["CZ"], new: ["CZ", "SK"] },
    }),
  ).toEqual([
    { type: "diff", field: "status", before: "completed", after: "pending" },
    {
      type: "diff",
      field: "practiceJurisdictions",
      before: ["CZ"],
      after: ["CZ", "SK"],
    },
  ]);
});

test("before and after envelopes read like old and new", () => {
  expect(
    auditChangeRows({
      due_date: { before: "2026-01-01", after: "2026-02-01" },
    }),
  ).toEqual([
    {
      type: "diff",
      field: "due_date",
      before: "2026-01-01",
      after: "2026-02-01",
    },
  ]);
});

test("a diff that records only one side keeps the other side empty", () => {
  expect(auditChangeRows({ name: { new: "Smlouva o dílo" } })).toEqual([
    { type: "diff", field: "name", before: undefined, after: "Smlouva o dílo" },
  ]);
});

test("payloads that are not field diffs are shown as values, never dropped", () => {
  expect(
    auditChangeRows({
      membersAdded: ["user-1"],
      title: "Kupní smlouva",
      settings: { old: 1, extra: true },
    }),
  ).toEqual([
    { type: "value", field: "membersAdded", value: ["user-1"] },
    { type: "value", field: "title", value: "Kupní smlouva" },
    { type: "value", field: "settings", value: { old: 1, extra: true } },
  ]);
  expect(auditChangeRows(["a", "b"])).toEqual([
    { type: "value", field: "", value: ["a", "b"] },
  ]);
});

test("no changes yields no rows", () => {
  expect(auditChangeRows(null)).toEqual([]);
  expect(auditChangeRows(undefined)).toEqual([]);
  expect(auditChangeRows({})).toEqual([]);
});

test("values read as text: empty is absent, structures are pretty-printed", () => {
  expect(formatAuditValue(null)).toBeNull();
  expect(formatAuditValue("")).toBeNull();
  expect(formatAuditValue("pending")).toBe("pending");
  expect(formatAuditValue(false)).toBe("false");
  expect(formatAuditValue(12.5)).toBe("12.5");
  expect(formatAuditValue({ a: 1 })).toBe('{\n  "a": 1\n}');
  expect(formatAuditValueInline({ a: 1 })).toBe('{"a":1}');
});
