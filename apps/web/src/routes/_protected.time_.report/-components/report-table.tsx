import { useState } from "react";

import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import type {
  TimeEntryReport,
  TimeEntryReportRow,
} from "@stll/api-contract/time-entry-report";
import { compareByLocale, compareCodeUnit } from "@stll/collation";
import { Button } from "@stll/ui/button";
import { TableCell, TableRow } from "@stll/ui/table";
import { TruncatedText } from "@stll/ui/truncated-text";

import {
  plainDateEpoch,
  SHORT_DATE,
} from "@/components/billing/format-plain-date";
import { useFormatter } from "@/i18n/formatting-context";
import { useMessageLocale } from "@/i18n/message-locale";
import { downloadFile } from "@/lib/utils";

import { REPORT_LABELS } from "./report-labels.logic";
import type { ReportFilter } from "./report-query";
import {
  approvalCellSearch,
  buildPivot,
  isInternalReportRow,
  pivotCsv,
  REPORT_GRID_CELL_LIMIT,
  reportCsvRows,
} from "./report.logic";
import { describeReportColumns, ReportGridFrame } from "./report.pending";

export const ReportTable = ({
  data,
  filter,
}: {
  data: TimeEntryReport;
  filter: ReportFilter;
}) => {
  const t = useTranslations();
  const locale = useMessageLocale();
  const format = useFormatter();
  const [expanded, setExpanded] = useState(new Set<string>());
  const columnSpec = describeReportColumns(filter);
  const columns = columnSpec.slice(1, -1).map(({ id }) => id);
  const columnLabel = (id: string) =>
    format.dateTime(plainDateEpoch(id), SHORT_DATE);
  const label = (row: TimeEntryReportRow) =>
    row.rowName ??
    t(
      isInternalReportRow(row)
        ? REPORT_LABELS.internal
        : REPORT_LABELS.unassigned,
    );
  const compareNames = compareByLocale(locale);
  const pivot = buildPivot(
    data.rows,
    columns,
    (a, b) =>
      compareNames(label(a), label(b)) || compareCodeUnit(a.rowId, b.rowId),
  );
  const visible = pivot.rows.filter(
    ({ row }) => row.parentId === null || expanded.has(row.parentId),
  );
  const hours = (minutes: number) =>
    format.number(minutes / 60, { maximumFractionDigits: 2 });
  // Past this size the grid would stall the page; the CSV holds every cell.
  const gridFits = visible.length * columns.length <= REPORT_GRID_CELL_LIMIT;
  const exportCsv = () =>
    downloadFile(
      new Blob(
        [
          pivotCsv(
            reportCsvRows({
              pivot,
              visible,
              columns,
              text: {
                group: t(REPORT_LABELS[filter.groupBy]),
                matter: t(REPORT_LABELS.matter),
                total: t(REPORT_LABELS.total),
                columns: columns.map(columnLabel),
                label,
                hours,
              },
            }),
          ),
        ],
        { type: "text/csv;charset=utf-8" },
      ),
      "team-time-report.csv",
    );
  return (
    <ReportGridFrame
      columns={columnSpec}
      action={
        <Button onClick={exportCsv} variant="outline">
          {t(REPORT_LABELS.exportCsv)}
        </Button>
      }
      header={(id) => {
        switch (id) {
          case "group":
            return t(REPORT_LABELS[filter.groupBy]);
          case "total":
            return t(REPORT_LABELS.total);
          default:
            return columnLabel(id);
        }
      }}
    >
      {!gridFits && (
        <TableRow>
          <TableCell colSpan={columns.length + 2}>
            {t(REPORT_LABELS.tooManyCells)}
          </TableCell>
        </TableRow>
      )}
      {(gridFits ? visible : []).map(({ row, cells, total }) => (
        <TableRow key={row.rowId}>
          <TableCell>
            <div className="flex min-w-0 items-center gap-2">
              {pivot.parentIds.has(row.rowId) && (
                <Button
                  aria-expanded={expanded.has(row.rowId)}
                  aria-label={t(
                    REPORT_LABELS[
                      expanded.has(row.rowId) ? "collapse" : "expand"
                    ],
                    { name: label(row) },
                  )}
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(row.rowId)) {
                        next.delete(row.rowId);
                      } else {
                        next.add(row.rowId);
                      }
                      return next;
                    })
                  }
                  size="sm"
                  variant="ghost"
                >
                  {expanded.has(row.rowId) ? "−" : "+"}
                </Button>
              )}
              <TruncatedText>{label(row)}</TruncatedText>
            </div>
          </TableCell>
          {columns.map((column) => {
            const minutes = cells.get(column) ?? 0;
            const search =
              minutes === 0 ? null : approvalCellSearch(row, column, filter);
            return (
              <TableCell key={column}>
                {search === null ? (
                  <span className="tabular-nums">{hours(minutes)}</span>
                ) : (
                  <Link
                    className="tabular-nums underline underline-offset-4"
                    to="/time/approvals"
                    search={search}
                  >
                    {hours(minutes)}
                  </Link>
                )}
              </TableCell>
            );
          })}
          <TableCell>
            <span className="font-medium tabular-nums">{hours(total)}</span>
          </TableCell>
        </TableRow>
      ))}
      {visible.length === 0 && (
        <TableRow>
          <TableCell colSpan={columns.length + 2}>
            {t(REPORT_LABELS.empty)}
          </TableCell>
        </TableRow>
      )}
      <TableRow>
        <TableCell>{t(REPORT_LABELS.total)}</TableCell>
        {columns.map((column) => (
          <TableCell key={column}>
            {hours(pivot.totals.get(column) ?? 0)}
          </TableCell>
        ))}
        <TableCell>{hours(pivot.total)}</TableCell>
      </TableRow>
    </ReportGridFrame>
  );
};
