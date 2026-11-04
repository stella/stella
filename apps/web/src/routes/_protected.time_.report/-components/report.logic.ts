import { panic } from "better-result";

import {
  TIME_ENTRY_REPORT_INTERNAL_ROW_ID,
  TIME_ENTRY_REPORT_PERIODS,
} from "@stll/api-contract/time-entry-report";
import type {
  TimeEntryReportBucket,
  TimeEntryReportGroupBy,
  TimeEntryReportRow,
} from "@stll/api-contract/time-entry-report";
import { Temporal } from "@stll/time";

import type { ReportSearch } from "./report-search";

export type ReportPeriod = (typeof TIME_ENTRY_REPORT_PERIODS)[number];
export type ReportRange = { from: string; to: string };
type ReportGrid = ReportRange & {
  groupBy: TimeEntryReportGroupBy;
  bucket: TimeEntryReportBucket;
};

/** The longest range the report reads, as the API bounds it. */
const MAX_REPORT_DAYS = 366;

/** A grid larger than this many cells is offered as a CSV export instead. */
export const REPORT_GRID_CELL_LIMIT = 20_000;

/** Both ends of a custom range, in order and within the report's bound. */
const customReportRange = (
  from: string | undefined,
  to: string | undefined,
): ReportRange | null => {
  if (from === undefined || to === undefined) {
    return null;
  }
  const days = Temporal.PlainDate.from(from).until(
    Temporal.PlainDate.from(to),
  ).days;
  return days >= 0 && days < MAX_REPORT_DAYS ? { from, to } : null;
};

/**
 * The period and filter a report URL asks for. A custom range the report
 * cannot show is dropped, as though the link never carried it, so the page
 * opens on the current week under the week tab rather than on another range
 * presented as the one asked for.
 */
export const resolveReportSearch = (
  search: ReportSearch,
  today: string,
): { period: ReportPeriod; filter: ReportGrid } => {
  const resolved = (period: ReportPeriod, range: ReportRange) => ({
    period,
    filter: {
      ...range,
      groupBy: search.groupBy ?? "member",
      bucket: search.bucket ?? (period === "week" ? "day" : "week"),
    },
  });
  if (search.period === "custom") {
    const custom = customReportRange(search.from, search.to);
    return custom === null
      ? resolved("week", reportRange("week", today))
      : resolved("custom", custom);
  }
  const period = search.period ?? "week";
  return resolved(period, reportRange(period, search.from ?? today));
};

export const reportRange = (
  period: Exclude<ReportPeriod, "custom">,
  date: string,
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
    default:
      period satisfies never;
      return panic("Unhandled report period");
  }
};

export const isReportPeriod = (value: unknown): value is ReportPeriod =>
  TIME_ENTRY_REPORT_PERIODS.some((period) => period === value);

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

type PivotRow = {
  row: TimeEntryReportRow;
  cells: Map<string, number>;
  total: number;
};

/**
 * Hours per row and column, in display order: each top-level row is followed
 * by its own expanded rows, both levels ordered by `order`. The API returns
 * every top-level row before any matter row, so arrival order would put a
 * member's matters after all other members.
 */
export const buildPivot = (
  rows: readonly TimeEntryReportRow[],
  columns: readonly string[],
  order: (a: TimeEntryReportRow, b: TimeEntryReportRow) => number,
) => {
  const byId = new Map<string, PivotRow>();
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
  const childrenOf = new Map<string, PivotRow[]>();
  const parents: PivotRow[] = [];
  for (const pivot of byId.values()) {
    const { parentId } = pivot.row;
    if (parentId === null) {
      parents.push(pivot);
      continue;
    }
    const siblings = childrenOf.get(parentId);
    if (siblings === undefined) {
      childrenOf.set(parentId, [pivot]);
    } else {
      siblings.push(pivot);
    }
  }
  const byOrder = (a: PivotRow, b: PivotRow) => order(a.row, b.row);
  return {
    rows: parents.toSorted(byOrder).flatMap((parent) => {
      const children = childrenOf.get(parent.row.rowId);
      return children === undefined
        ? [parent]
        : [parent, ...children.toSorted(byOrder)];
    }),
    byId,
    parentIds: new Set(childrenOf.keys()),
    totals,
    total,
  };
};

/** Time recorded without a matter, on any grouping. */
export const isInternalReportRow = (row: TimeEntryReportRow) =>
  row.rowId === TIME_ENTRY_REPORT_INTERNAL_ROW_ID ||
  (row.parentId !== null && row.matterId === null);

/**
 * The approvals page lists one calendar week, filtered by member and matter.
 * A cell links there only when that list is scoped to the cell's own row: a
 * month spans several weeks, the page has no client filter, and a row
 * without a member or matter id (internal work, a removed member) would
 * open the whole team's week.
 */
export const approvalCellSearch = (
  row: TimeEntryReportRow,
  column: string,
  filter: ReportGrid,
): { date: string; member?: string; matter?: string } | null => {
  if (filter.bucket === "month") {
    return null;
  }
  const date = column < filter.from ? filter.from : column;
  if (row.parentId !== null) {
    return row.memberId === null || row.matterId === null
      ? null
      : { date, member: row.memberId, matter: row.matterId };
  }
  switch (filter.groupBy) {
    case "member":
      return row.memberId === null ? null : { date, member: row.memberId };
    case "matter":
      return row.matterId === null ? null : { date, matter: row.matterId };
    case "client":
      return null;
    default:
      filter.groupBy satisfies never;
      return panic("Unhandled report grouping");
  }
};

type ReportPivot = ReturnType<typeof buildPivot>;

/**
 * CSV rows for the visible pivot. Expanded matter rows repeat their member's
 * hours, so when any is visible a matter column names them and stays empty
 * on member rows and on the total: the rows with an empty matter add up to
 * the total.
 */
export const reportCsvRows = ({
  pivot,
  visible,
  columns,
  text,
}: {
  pivot: ReportPivot;
  visible: ReportPivot["rows"];
  columns: readonly string[];
  text: {
    group: string;
    matter: string;
    total: string;
    columns: readonly string[];
    label: (row: TimeEntryReportRow) => string;
    hours: (minutes: number) => string;
  };
}): string[][] => {
  const detailed = visible.some(({ row }) => row.parentId !== null);
  const parentLabel = (parentId: string) => {
    const parent = pivot.byId.get(parentId);
    return parent === undefined ? "" : text.label(parent.row);
  };
  const leading = (row: TimeEntryReportRow | null) => {
    if (!detailed) {
      return [row === null ? text.total : text.label(row)];
    }
    if (row === null) {
      return [text.total, ""];
    }
    return row.parentId === null
      ? [text.label(row), ""]
      : [parentLabel(row.parentId), text.label(row)];
  };
  return [
    [
      text.group,
      ...(detailed ? [text.matter] : []),
      ...text.columns,
      text.total,
    ],
    ...visible.map(({ row, cells, total }) => [
      ...leading(row),
      ...columns.map((column) => text.hours(cells.get(column) ?? 0)),
      text.hours(total),
    ]),
    [
      ...leading(null),
      ...columns.map((column) => text.hours(pivot.totals.get(column) ?? 0)),
      text.hours(pivot.total),
    ],
  ];
};

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
