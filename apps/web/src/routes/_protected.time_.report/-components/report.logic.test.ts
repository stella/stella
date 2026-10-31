import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { TimeEntryReportRow } from "@stll/api-contract/time-entry-report";

import { reportSearchSchema } from "./report-search";
import {
  approvalCellSearch,
  buildPivot,
  pivotCsv,
  reportColumns,
  reportRange,
  shiftReportRange,
} from "./report.logic";

describe("report periods", () => {
  test("uses calendar weeks and leap-year months", () => {
    expect(reportRange("week", "2026-11-01")).toEqual({
      from: "2026-10-26",
      to: "2026-11-01",
    });
    expect(reportRange("month", "2024-02-17")).toEqual({
      from: "2024-02-01",
      to: "2024-02-29",
    });
  });
  test("moves months by calendar and custom ranges by inclusive length", () => {
    expect(
      shiftReportRange({ from: "2024-02-01", to: "2024-02-29" }, "month", 1),
    ).toEqual({ from: "2024-03-01", to: "2024-03-31" });
    expect(
      shiftReportRange({ from: "2026-10-26", to: "2026-10-28" }, "custom", -1),
    ).toEqual({ from: "2026-10-23", to: "2026-10-25" });
  });
  test("includes partial weekly and monthly columns", () => {
    expect(
      reportColumns({ from: "2026-10-31", to: "2026-11-03" }, "week"),
    ).toEqual(["2026-10-26", "2026-11-02"]);
    expect(
      reportColumns({ from: "2026-10-31", to: "2026-11-03" }, "month"),
    ).toEqual(["2026-10-01", "2026-11-01"]);
  });
  test("drops malformed dates and unsupported discriminators", () => {
    expect(
      v.parse(reportSearchSchema, {
        from: "2026-02-30",
        bucket: "hour",
        period: "year",
        groupBy: "user",
      }),
    ).toEqual({});
  });
});

const row = (
  overrides: Partial<TimeEntryReportRow> = {},
): TimeEntryReportRow => ({
  rowId: "member-a",
  rowName: "Anna",
  memberId: "a",
  matterId: null,
  parentId: null,
  bucket: "2026-10-26",
  minutes: 60,
  ...overrides,
});

describe("report pivot", () => {
  test("computes totals without counting expanded matter hours twice", () => {
    const pivot = buildPivot(
      [
        row(),
        row({ bucket: "2026-10-27", minutes: 30 }),
        row({
          rowId: "child",
          parentId: "member-a",
          matterId: "matter-a",
          minutes: 60,
        }),
        row({ rowId: "member-b", memberId: "b", minutes: 120 }),
      ],
      ["2026-10-26", "2026-10-27"],
    );
    expect(pivot.total).toBe(210);
    expect([...pivot.totals.values()]).toEqual([180, 30]);
    expect(
      pivot.rows.find(({ row: entry }) => entry.rowId === "member-a")?.total,
    ).toBe(90);
  });
  test("links expressible member and matter filters to the cell's week", () => {
    expect(
      approvalCellSearch(row({ matterId: "matter-a" }), "2026-10-27"),
    ).toEqual({ date: "2026-10-27", member: "a", matter: "matter-a" });
    expect(approvalCellSearch(row({ memberId: null }), "2026-10-27")).toEqual({
      date: "2026-10-27",
    });
  });
  test("quotes CSV and protects spreadsheet formulas in row labels", () => {
    expect(pivotCsv([["=cmd()", 'Name, "quoted"', "2.5"]])).toBe(
      '"\'=cmd()","Name, ""quoted""","2.5"',
    );
  });
});
