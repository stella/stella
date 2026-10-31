import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  TIME_ENTRY_REPORT_INTERNAL_ROW_ID,
  TIME_ENTRY_REPORT_NO_CLIENT_ROW_ID,
  type TimeEntryReportRow,
} from "@stll/api-contract/time-entry-report";

import { reportSearchSchema } from "./report-search";
import {
  approvalCellSearch,
  buildPivot,
  isInternalReportRow,
  pivotCsv,
  reportColumns,
  reportCsvRows,
  reportRange,
  resolveReportSearch,
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
  test("opens a custom range only when it is complete, ordered and within 366 days", () => {
    const today = "2026-10-31";
    const week: ReturnType<typeof resolveReportSearch> = {
      period: "week",
      filter: {
        from: "2026-10-26",
        to: "2026-11-01",
        groupBy: "member",
        bucket: "day",
      },
    };
    expect(
      resolveReportSearch(
        { period: "custom", from: "2026-01-01", to: "2026-12-31" },
        today,
      ),
    ).toEqual({
      period: "custom",
      filter: {
        from: "2026-01-01",
        to: "2026-12-31",
        groupBy: "member",
        bucket: "week",
      },
    });
    for (const search of [
      { period: "custom", from: "2026-05-02", to: "2026-05-01" },
      // 367 days, one more than the report reads.
      { period: "custom", from: "2024-01-01", to: "2025-01-01" },
      { period: "custom", from: "2026-05-01" },
      { period: "custom" },
    ] as const) {
      expect(resolveReportSearch(search, today)).toEqual(week);
    }
    expect(
      resolveReportSearch({ period: "month", from: "2024-02-17" }, today),
    ).toEqual({
      period: "month",
      filter: {
        from: "2024-02-01",
        to: "2024-02-29",
        groupBy: "member",
        bucket: "week",
      },
    });
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
  test("links a cell to the approvals week only when that week is scoped to its row", () => {
    const grid = {
      from: "2026-10-28",
      to: "2026-11-03",
      groupBy: "member",
      bucket: "day",
    } as const;
    expect(approvalCellSearch(row(), "2026-10-29", grid)).toEqual({
      date: "2026-10-29",
      member: "a",
    });
    // A partial first week opens at the range start.
    expect(
      approvalCellSearch(
        row({
          rowId: "a:matter-a",
          parentId: "member-a",
          matterId: "matter-a",
        }),
        "2026-10-26",
        { ...grid, bucket: "week" },
      ),
    ).toEqual({ date: "2026-10-28", member: "a", matter: "matter-a" });
    expect(
      approvalCellSearch(
        row({ rowId: "matter-a", memberId: null, matterId: "matter-a" }),
        "2026-10-29",
        { ...grid, groupBy: "matter" },
      ),
    ).toEqual({ date: "2026-10-29", matter: "matter-a" });
    // A month spans several approval weeks.
    expect(
      approvalCellSearch(row(), "2026-10-01", { ...grid, bucket: "month" }),
    ).toBeNull();
    // The approvals page cannot filter by client.
    expect(
      approvalCellSearch(
        row({ rowId: "client-a", memberId: null }),
        "2026-10-29",
        {
          ...grid,
          groupBy: "client",
        },
      ),
    ).toBeNull();
    // Rows without an id would open the whole team's week.
    expect(
      approvalCellSearch(row({ memberId: null }), "2026-10-29", grid),
    ).toBeNull();
    expect(
      approvalCellSearch(
        row({ rowId: "internal", memberId: null }),
        "2026-10-29",
        { ...grid, groupBy: "matter" },
      ),
    ).toBeNull();
    expect(
      approvalCellSearch(
        row({ rowId: "a:internal", parentId: "member-a" }),
        "2026-10-29",
        grid,
      ),
    ).toBeNull();
  });
  test("names internal work apart from unnamed rows", () => {
    expect(
      isInternalReportRow(
        row({ rowId: TIME_ENTRY_REPORT_INTERNAL_ROW_ID, rowName: null }),
      ),
    ).toBe(true);
    expect(
      isInternalReportRow(
        row({ rowId: "a:internal", parentId: "member-a", rowName: null }),
      ),
    ).toBe(true);
    expect(
      isInternalReportRow(
        row({ rowId: TIME_ENTRY_REPORT_NO_CLIENT_ROW_ID, rowName: null }),
      ),
    ).toBe(false);
    expect(isInternalReportRow(row({ rowName: null }))).toBe(false);
  });
  test("marks expanded matter rows in the CSV so its rows add up to the total", () => {
    const columns = ["2026-10-26"];
    const pivot = buildPivot(
      [
        row(),
        row({
          rowId: "a:matter-a",
          rowName: "Lease",
          parentId: "member-a",
          matterId: "matter-a",
        }),
        row({ rowId: "member-b", rowName: "Ben", memberId: "b", minutes: 30 }),
      ],
      columns,
    );
    const text = {
      group: "Member",
      matter: "Matter",
      total: "Total",
      columns: ["26 Oct"],
      label: (entry: TimeEntryReportRow) => entry.rowName ?? "",
      hours: (minutes: number) => String(minutes / 60),
    };
    const collapsed = pivot.rows.filter(({ row: entry }) => !entry.parentId);
    expect(reportCsvRows({ pivot, visible: collapsed, columns, text })).toEqual(
      [
        ["Member", "26 Oct", "Total"],
        ["Anna", "1", "1"],
        ["Ben", "0.5", "0.5"],
        ["Total", "1.5", "1.5"],
      ],
    );
    const detailed = reportCsvRows({
      pivot,
      visible: pivot.rows,
      columns,
      text,
    });
    expect(detailed).toEqual([
      ["Member", "Matter", "26 Oct", "Total"],
      ["Anna", "", "1", "1"],
      ["Anna", "Lease", "1", "1"],
      ["Ben", "", "0.5", "0.5"],
      ["Total", "", "1.5", "1.5"],
    ]);
    expect(
      detailed
        .slice(1, -1)
        .filter((line) => line[1] === "")
        .reduce((sum, line) => sum + Number(line.at(-1)), 0),
    ).toBe(Number(detailed.at(-1)?.at(-1)));
  });
  test("quotes CSV and protects spreadsheet formulas in row labels", () => {
    expect(pivotCsv([["=cmd()", 'Name, "quoted"', "2.5"]])).toBe(
      '"\'=cmd()","Name, ""quoted""","2.5"',
    );
  });
});
