import { useState } from "react";

import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import type { TimeEntryReport } from "@stll/api-contract/time-entry-report";
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
import { downloadFile } from "@/lib/utils";

import { REPORT_LABELS } from "./report-labels";
import type { ReportFilter } from "./report-query";
import {
  approvalCellSearch,
  buildPivot,
  pivotCsv,
  reportColumns,
} from "./report.logic";

export const ReportTable = ({
  data,
  filter,
}: {
  data: TimeEntryReport | undefined;
  filter: ReportFilter;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const [expanded, setExpanded] = useState(new Set<string>());
  const columns = reportColumns(filter, filter.bucket);
  const pivot = buildPivot(data?.rows ?? [], columns);
  const visible = pivot.rows.filter(
    ({ row }) => row.parentId === null || expanded.has(row.parentId),
  );
  const hours = (minutes: number) =>
    format.number(minutes / 60, { maximumFractionDigits: 2 });
  const label = (name: string | null) => name ?? t(REPORT_LABELS.unassigned);
  const columnLabels = columns.map((column) =>
    format.dateTime(plainDateEpoch(column), SHORT_DATE),
  );
  const exportCsv = () =>
    downloadFile(
      new Blob(
        [
          pivotCsv([
            [
              t(REPORT_LABELS[filter.groupBy]),
              ...columnLabels,
              t(REPORT_LABELS.total),
            ],
            ...visible.map(({ row, cells, total }) => [
              label(row.rowName),
              ...columns.map((column) => hours(cells.get(column) ?? 0)),
              hours(total),
            ]),
            [
              t(REPORT_LABELS.total),
              ...columns.map((column) => hours(pivot.totals.get(column) ?? 0)),
              hours(pivot.total),
            ],
          ]),
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
          {visible.map(({ row, cells, total }) => (
            <TableRow key={row.rowId}>
              <TableCell>
                <div className="flex min-w-0 items-center gap-2">
                  {pivot.rows.some(
                    (child) => child.row.parentId === row.rowId,
                  ) && (
                    <Button
                      aria-expanded={expanded.has(row.rowId)}
                      aria-label={t(
                        REPORT_LABELS[
                          expanded.has(row.rowId) ? "collapse" : "expand"
                        ],
                        { name: label(row.rowName) },
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
                  <TruncatedText>{label(row.rowName)}</TruncatedText>
                </div>
              </TableCell>
              {columns.map((column) => (
                <TableCell key={column}>
                  <Link
                    className="tabular-nums underline underline-offset-4"
                    to="/time/approvals"
                    search={approvalCellSearch(
                      row,
                      column < filter.from ? filter.from : column,
                    )}
                  >
                    {hours(cells.get(column) ?? 0)}
                  </Link>
                </TableCell>
              ))}
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
