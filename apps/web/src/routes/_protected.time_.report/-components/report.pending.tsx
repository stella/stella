import type { ReactNode } from "react";

import { useSearch } from "@tanstack/react-router";

import { ButtonFace } from "@stll/ui/control-face";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import {
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
} from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeletonRows,
} from "@stll/ui/table-shell";
import { cn } from "@stll/ui/utils";

import { todayIn } from "@/components/billing/work-week.logic";
import { PendingDate, PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

import { REPORT_LABELS } from "./report-labels.logic";
import type { ReportFilter } from "./report-query";
import { readReportSearch } from "./report-search.logic";
import {
  REPORT_PERIODS,
  reportColumns,
  type ReportPeriod,
  resolveReportSearch,
} from "./report.logic";

export const REPORT_METRICS = [
  { key: "billableHours" },
  { key: "billableShare" },
  { key: "pendingEntries" },
  { key: "activeMembers" },
] as const;

export type ReportMetric = (typeof REPORT_METRICS)[number]["key"];

export const ReportShell = ({
  controls,
  title,
  privacy,
  children,
}: {
  controls: ReactNode;
  title: ReactNode;
  privacy: ReactNode;
  children: ReactNode;
}) => (
  <ScrollArea className="h-full">
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <h1 className="text-lg font-medium">{title}</h1>
      <div className="flex flex-wrap items-end gap-3">{controls}</div>
      {children}
      <div className="text-muted-foreground text-xs">{privacy}</div>
    </div>
  </ScrollArea>
);

export const ReportTile = ({
  label,
  labelText,
  children,
}: {
  label: ReactNode;
  labelText?: string;
  children: ReactNode;
}) => (
  <section className="min-w-32" aria-label={labelText}>
    <h2 className="text-muted-foreground text-xs">{label}</h2>
    {children}
  </section>
);

export const ReportTiles = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-wrap gap-6 py-4">{children}</div>
);

export const ReportControlField = ({
  label,
  labelId,
  children,
}: {
  label: ReactNode;
  labelId?: string;
  children: ReactNode;
}) => (
  <div className="flex flex-col gap-1">
    <span
      className="text-foreground inline-flex items-center gap-2 text-base/4.5 font-medium sm:text-sm/4"
      id={labelId}
    >
      {label}
    </span>
    {children}
  </div>
);

const PENDING_DATE_FORMAT = {
  month: "short",
  day: "numeric",
  year: "numeric",
  calendar: "gregory",
  timeZone: "UTC",
} as const satisfies Intl.DateTimeFormatOptions;

const DateFieldFace = ({ date }: { date?: string | undefined }) => (
  <span
    className="flex min-h-7 min-w-28 items-center gap-1.5 rounded-md px-1.5 text-sm opacity-64"
    aria-hidden="true"
  >
    <CalendarIcon className="size-3.5 shrink-0" />
    <PendingDate date={date} options={PENDING_DATE_FORMAT} />
  </span>
);

const SelectFieldFace = ({ children }: { children: ReactNode }) => (
  <ButtonFace
    size="default"
    variant="outline"
    className="min-w-28 justify-between"
  >
    {children}
    <ChevronsUpDownIcon className="size-4 opacity-80" />
  </ButtonFace>
);

const ReportControlsFace = ({
  filter,
  period,
  showDates,
}: {
  filter: ReportFilter;
  period: ReportPeriod;
  showDates: boolean;
}) => (
  <>
    <div
      className="bg-muted text-foreground-label flex w-fit max-w-full items-center gap-x-0.5 rounded-lg p-0.5"
      aria-hidden="true"
    >
      {REPORT_PERIODS.map((value) => (
        <span
          className={cn(
            "flex h-9 min-w-16 items-center justify-center rounded-md border border-transparent px-[calc(--spacing(2.5)-1px)] text-base font-medium whitespace-nowrap sm:h-8 sm:text-sm",
            value === period &&
              "bg-background text-foreground dark:bg-input shadow-sm/5",
          )}
          key={value}
        >
          <PendingText id={REPORT_LABELS[value]} barClassName="w-9" />
        </span>
      ))}
    </div>
    <ButtonFace size="icon" variant="ghost">
      <DirectionalIcon icon={ChevronLeftIcon} />
    </ButtonFace>
    <ReportControlField
      label={<PendingText id={REPORT_LABELS.from} barClassName="w-12" />}
    >
      <DateFieldFace date={showDates ? filter.from : undefined} />
    </ReportControlField>
    <ReportControlField
      label={<PendingText id={REPORT_LABELS.to} barClassName="w-12" />}
    >
      <DateFieldFace date={showDates ? filter.to : undefined} />
    </ReportControlField>
    <ButtonFace size="icon" variant="ghost">
      <DirectionalIcon icon={ChevronRightIcon} />
    </ButtonFace>
    <ReportControlField
      label={<PendingText id={REPORT_LABELS.rows} barClassName="w-12" />}
    >
      <SelectFieldFace>
        <PendingText id={REPORT_LABELS[filter.groupBy]} barClassName="w-12" />
      </SelectFieldFace>
    </ReportControlField>
    <ReportControlField
      label={<PendingText id={REPORT_LABELS.columns} barClassName="w-12" />}
    >
      <SelectFieldFace>
        <PendingText id={REPORT_LABELS[filter.bucket]} barClassName="w-12" />
      </SelectFieldFace>
    </ReportControlField>
  </>
);

export const describeReportColumns = (filter: ReportFilter) => {
  const dates = reportColumns(filter, filter.bucket);
  return [
    { id: "group", bar: "w-24", width: "w-44" },
    ...dates.map((date) => ({ id: date, bar: "w-8", width: "w-20" })),
    { id: "total", bar: "w-8", width: "w-20" },
  ];
};

export const ReportGridFrame = ({
  columns,
  header,
  action,
  busy,
  children,
}: {
  columns: ReturnType<typeof describeReportColumns>;
  header: (id: string) => ReactNode;
  action: ReactNode;
  busy?: boolean;
  children: ReactNode;
}) => (
  <section className="flex min-w-0 flex-col gap-3" aria-busy={busy}>
    <div className="flex justify-end">{action}</div>
    <Table className={cn(busy && "table-fixed")}>
      <TableHeader>
        <TableRow>
          {columns.map(({ id, width }) => (
            <TableHead className={cn(busy && width)} key={id}>
              {header(id)}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  </section>
);

export const ReportFiguresSkeleton = ({
  filter,
  showDates = true,
}: {
  filter: ReportFilter;
  showDates?: boolean;
}) => {
  const columns = describeReportColumns(filter);
  return (
    <>
      <ReportTiles>
        {REPORT_METRICS.map(({ key }) => (
          <ReportTile
            key={key}
            label={<PendingText id={REPORT_LABELS[key]} barClassName="w-20" />}
          >
            <div className="flex h-8 items-center">
              <Skeleton className="h-5 w-16" />
            </div>
            <div className="flex h-4 items-center">
              <Skeleton className="h-2.5 w-20" />
            </div>
          </ReportTile>
        ))}
      </ReportTiles>
      <ReportGridFrame
        busy
        columns={columns}
        action={
          <ButtonFace size="default" variant="outline">
            <PendingText id={REPORT_LABELS.exportCsv} />
          </ButtonFace>
        }
        header={(id) => {
          switch (id) {
            case "group":
              return (
                <PendingText
                  id={REPORT_LABELS[filter.groupBy]}
                  barClassName="w-16"
                />
              );
            case "total":
              return (
                <PendingText id={REPORT_LABELS.total} barClassName="w-10" />
              );
            default:
              return <PendingDate date={showDates ? id : undefined} />;
          }
        }}
      >
        <TableSkeletonRows columns={columns} count={4} />
      </ReportGridFrame>
    </>
  );
};

export const TimeReportPending = framePendingView(() => {
  const search = useSearch({ strict: false, select: readReportSearch });
  const { filter, period } = resolveReportSearch(search, todayIn("UTC"));
  const showDates =
    search.from !== undefined &&
    (search.period !== "custom" || period === "custom");
  return (
    <ReportShell
      title={<PendingText id={REPORT_LABELS.title} />}
      privacy={<PendingText id={REPORT_LABELS.privacy} barClassName="w-56" />}
      controls={
        <ReportControlsFace
          filter={filter}
          period={period}
          showDates={showDates}
        />
      }
    >
      <ReportFiguresSkeleton filter={filter} showDates={showDates} />
    </ReportShell>
  );
});
