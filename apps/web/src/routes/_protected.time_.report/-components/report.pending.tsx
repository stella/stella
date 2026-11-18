import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Label } from "@stll/ui/label";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";

import { REPORT_LABELS } from "./report-labels";

/** The summary tiles, in the order the page shows them. */
export const REPORT_METRICS = [
  { key: "billableHours" },
  { key: "billableShare" },
  { key: "pendingEntries" },
  { key: "activeMembers" },
] as const;

export type ReportMetric = (typeof REPORT_METRICS)[number]["key"];

/** Rows held open while the report loads. */
const PENDING_ROWS = 4;
/** A week's report: the group column, seven days and the total. */
const PENDING_COLUMNS = 9;

/**
 * The time report's frame: the title, the controls row, the report and the
 * privacy note. The loaded page and its pending view render the same frame,
 * so nothing moves when the figures arrive.
 */
export const ReportShell = ({
  controls,
  children,
}: {
  controls: ReactNode;
  children: ReactNode;
}) => {
  const t = useTranslations();
  return (
    <ScrollArea className="h-full">
      <div className="flex min-w-0 flex-col gap-4 p-4">
        <h1 className="text-lg font-medium">{t(REPORT_LABELS.title)}</h1>
        <div className="flex flex-wrap items-end gap-3">{controls}</div>
        {children}
        <p className="text-muted-foreground text-xs">
          {t(REPORT_LABELS.privacy)}
        </p>
      </div>
    </ScrollArea>
  );
};

/** One summary tile: its heading over the figure. */
export const ReportTile = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <section className="min-w-32" aria-label={label}>
    <h2 className="text-muted-foreground text-xs">{label}</h2>
    {children}
  </section>
);

/** The row of summary tiles. */
export const ReportTiles = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-wrap gap-6 py-4">{children}</div>
);

/** A labelled control's slot in the controls row. */
const PendingField = ({
  labelKey,
}: {
  labelKey: "from" | "to" | "rows" | "columns";
}) => {
  const t = useTranslations();
  return (
    <div className="flex flex-col gap-1">
      <Label>{t(REPORT_LABELS[labelKey])}</Label>
      <Skeleton className="h-9 w-36" />
    </div>
  );
};

/** The time report while its figures load. */
export const TimeReportPending = () => {
  const t = useTranslations();
  return (
    <ReportShell
      controls={
        <>
          <Skeleton className="h-9 w-52" />
          <Skeleton className="size-9" />
          <PendingField labelKey="from" />
          <PendingField labelKey="to" />
          <Skeleton className="size-9" />
          <PendingField labelKey="rows" />
          <PendingField labelKey="columns" />
        </>
      }
    >
      <ReportTiles>
        {REPORT_METRICS.map(({ key }) => (
          <ReportTile key={key} label={t(REPORT_LABELS[key])}>
            <Skeleton className="h-12 w-24" />
          </ReportTile>
        ))}
        <section aria-label={t(REPORT_LABELS.unbilledValue)}>
          <h2 className="text-muted-foreground text-xs">
            {t(REPORT_LABELS.unbilledValue)}
          </h2>
          <Skeleton className="h-12 w-24" />
        </section>
      </ReportTiles>
      <section className="flex min-w-0 flex-col gap-3">
        <div className="flex justify-end">
          <Button disabled variant="outline">
            {t(REPORT_LABELS.exportCsv)}
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              {Array.from({ length: PENDING_COLUMNS }, (_, column) => (
                <TableHead key={column}>
                  <Skeleton className="h-4 w-12" />
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: PENDING_ROWS }, (_, row) => (
              <TableRow key={row}>
                {Array.from({ length: PENDING_COLUMNS }, (_cell, cell) => (
                  <TableCell key={cell}>
                    <Skeleton className="h-5 w-16" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </ReportShell>
  );
};
