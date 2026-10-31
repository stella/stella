import { useState } from "react";

import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import type {
  TimeEntryReport,
  TimeEntryReportRow,
} from "@stll/api-contract/time-entry-report";
import { compareByLocale, compareCodeUnit } from "@stll/collation";
import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";
import { TruncatedText } from "@stll/ui/truncated-text";

import {
  plainDateEpoch,
  SHORT_DATE,
} from "@/components/billing/format-plain-date";
import { useFormatter } from "@/i18n/formatting-context";
import { useMessageLocale } from "@/i18n/message-locale";
import { downloadFile } from "@/lib/utils";

import { REPORT_LABELS } from "./report-labels";
import type { ReportFilter } from "./report-query";
import {
  approvalCellSearch,
  buildPivot,
  isInternalReportRow,
  pivotCsv,
  REPORT_GRID_CELL_LIMIT,
  reportColumns,
  reportCsvRows,
} from "./report.logic";

export const ReportTable = ({
  data,
  filter,
}: {
  data: TimeEntryReport | undefined;
  filter: ReportFilter;
}) => {
  const t = useTranslations();
  const locale = useMessageLocale();
  const format = useFormatter();
  const [expanded, setExpanded] = useState(new Set<string>());
  const columns = reportColumns(filter, filter.bucket);
  const label = (row: TimeEntryReportRow) =>
    row.rowName ??
    t(
      isInternalReportRow(row)
        ? REPORT_LABELS.internal
        : REPORT_LABELS.unassigned,
    );
  const compareNames = compareByLocale(locale);
  // While loading the pivot has no rows; the skeleton rows stand in.
  const pivot = buildPivot(
    data === undefined ? [] : data.rows,
    columns,
    (a, b) =>
      compareNames(label(a), label(b)) || compareCodeUnit(a.rowId, b.rowId),
  );
  const visible = pivot.rows.filter(
    ({ row }) => row.parentId === null || expanded.has(row.parentId),
  );
  const hours = (minutes: number) =>
    format.number(minutes / 60, { maximumFractionDigits: 2 });
  const columnLabels = columns.map((column) =>
    format.dateTime(plainDateEpoch(column), SHORT_DATE),
  );
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
                columns: columnLabels,
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
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex justify-end">
        <Button
          disabled={data === undefined}
          onClick={exportCsv}
          variant="outline"
        >
          {t(REPORT_LABELS.exportCsv)}
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t(REPORT_LABELS[filter.groupBy])}</TableHead>
            {columns.map((column, index) => (
              <TableHead key={column}>{columnLabels[index]}</TableHead>
            ))}
            <TableHead>{t(REPORT_LABELS.total)}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data === undefined &&
            Array.from({ length: 4 }, (_, index) => (
              <TableRow key={index}>
                {Array.from({ length: columns.length + 2 }, (_cell, cell) => (
                  <TableCell key={cell}>
                    <Skeleton className="h-5 w-16" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
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
                  minutes === 0
                    ? null
                    : approvalCellSearch(row, column, filter);
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
          {data !== undefined && visible.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns.length + 2}>
                {t(REPORT_LABELS.empty)}
              </TableCell>
            </TableRow>
          )}
          {data !== undefined && (
            <TableRow>
              <TableCell>{t(REPORT_LABELS.total)}</TableCell>
              {columns.map((column) => (
                <TableCell key={column}>
                  {hours(pivot.totals.get(column) ?? 0)}
                </TableCell>
              ))}
              <TableCell>{hours(pivot.total)}</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </section>
  );
};
