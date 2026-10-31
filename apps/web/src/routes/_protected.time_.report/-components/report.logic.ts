import type {
  TIME_ENTRY_REPORT_PERIODS,
  TimeEntryReportBucket,
  TimeEntryReportRow,
} from "@stll/api-contract/time-entry-report";
import { Temporal } from "@stll/time";

export type ReportPeriod = (typeof TIME_ENTRY_REPORT_PERIODS)[number];
export type ReportRange = { from: string; to: string };

export const reportRange = (
  period: ReportPeriod,
  date: string,
  custom?: ReportRange,
): ReportRange => {
  const day = Temporal.PlainDate.from(date);
  switch (period) {
    case "week": {
      const from = day.subtract({ days: day.dayOfWeek - 1 });
      return { from: from.toString(), to: from.add({ days: 6 }).toString() };
    }
    case "month": {
      const from = day.with({ day: 1 });
      return {
        from: from.toString(),
        to: from.add({ months: 1 }).subtract({ days: 1 }).toString(),
      };
    }
    case "custom":
      return custom ?? { from: date, to: date };
  }
};

export const shiftReportRange = (
  range: ReportRange,
  period: ReportPeriod,
  direction: -1 | 1,
): ReportRange => {
  if (period === "month") {
    return reportRange(
      period,
      Temporal.PlainDate.from(range.from).add({ months: direction }).toString(),
    );
  }
  const length =
    Temporal.PlainDate.from(range.from).until(Temporal.PlainDate.from(range.to))
      .days + 1;
  return {
    from: Temporal.PlainDate.from(range.from)
      .add({ days: length * direction })
      .toString(),
    to: Temporal.PlainDate.from(range.to)
      .add({ days: length * direction })
      .toString(),
  };
};

export const reportColumns = (
  range: ReportRange,
  bucket: TimeEntryReportBucket,
): string[] => {
  const columns = new Set<string>();
  const end = Temporal.PlainDate.from(range.to);
  for (
    let day = Temporal.PlainDate.from(range.from);
    Temporal.PlainDate.compare(day, end) <= 0;
    day = day.add({ days: 1 })
  ) {
    switch (bucket) {
      case "day":
        columns.add(day.toString());
        break;
      case "week":
        columns.add(day.subtract({ days: day.dayOfWeek - 1 }).toString());
        break;
      case "month":
        columns.add(day.with({ day: 1 }).toString());
        break;
    }
  }
  return [...columns];
};

export const buildPivot = (
  rows: readonly TimeEntryReportRow[],
  columns: readonly string[],
) => {
  const byId = new Map<
    string,
    { row: TimeEntryReportRow; cells: Map<string, number>; total: number }
  >();
  const totals = new Map(columns.map((column) => [column, 0]));
  let total = 0;
  for (const row of rows) {
    const pivot = byId.get(row.rowId) ?? {
      row,
      cells: new Map<string, number>(),
      total: 0,
    };
    pivot.cells.set(
      row.bucket,
      (pivot.cells.get(row.bucket) ?? 0) + row.minutes,
    );
    pivot.total += row.minutes;
    byId.set(row.rowId, pivot);
    // Expanded matter rows repeat their member's hours.
    if (row.parentId === null) {
      totals.set(row.bucket, (totals.get(row.bucket) ?? 0) + row.minutes);
      total += row.minutes;
    }
  }
  return { rows: [...byId.values()], totals, total };
};

export const approvalCellSearch = (row: TimeEntryReportRow, date: string) => ({
  date,
  ...(row.memberId === null ? {} : { member: row.memberId }),
  ...(row.matterId === null ? {} : { matter: row.matterId }),
});

export const pivotCsv = (rows: readonly (readonly string[])[]) =>
  rows
    .map((row) =>
      row
        .map((value) => {
          const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
          return `"${safe.replaceAll('"', '""')}"`;
        })
        .join(","),
    )
    .join("\r\n");
