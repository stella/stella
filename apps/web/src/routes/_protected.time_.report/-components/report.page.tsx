import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import {
  TIME_ENTRY_REPORT_BUCKETS,
  TIME_ENTRY_REPORT_GROUPS,
} from "@stll/api-contract/time-entry-report";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronLeftIcon, ChevronRightIcon } from "@stll/ui/icons";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@stll/ui/tabs";

import { todayIn } from "@/components/billing/work-week.logic";
import { DatePickerPopover } from "@/components/date-picker-popover";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { detached } from "@/lib/detached";
import { queryView, queryViewError } from "@/lib/query-view.logic";

import { REPORT_LABELS } from "./report-labels.logic";
import {
  type ReportFilter,
  timeReportOptions,
  type TimeReportResult,
} from "./report-query";
import { ReportSummary } from "./report-summary";
import { ReportTable } from "./report-table";
import {
  isReportPeriod,
  REPORT_PERIODS,
  type ReportPeriod,
  resolveReportSearch,
  shiftReportRange,
} from "./report.logic";
import {
  ReportControlField,
  ReportFiguresSkeleton,
  ReportShell,
} from "./report.pending";

const routeApi = getRouteApi("/_protected/time_/report");

/** /time/report: the report the search names, in the person's own zone. */
export const TimeReportPage = () => {
  const search = routeApi.useSearch({ select: (value) => value });
  const { organizationId, userId, timezoneId } = routeApi.useRouteContext({
    select: (context) => ({
      organizationId: context.user.activeOrganizationId,
      userId: context.user.id,
      timezoneId: context.user.timezoneId,
    }),
  });
  const navigate = routeApi.useNavigate();
  const { filter, period } = resolveReportSearch(search, todayIn(timezoneId));
  return (
    <ReportPage
      organizationId={organizationId}
      userId={userId}
      filter={filter}
      period={period}
      onChange={(next, nextPeriod) =>
        detached(
          navigate({ search: { ...next, period: nextPeriod } }),
          "time-report.navigate",
        )
      }
    />
  );
};

const ReportPage = ({
  organizationId,
  userId,
  filter,
  period,
  onChange,
}: {
  organizationId: string;
  userId: string;
  filter: ReportFilter;
  period: ReportPeriod;
  onChange: (filter: ReportFilter, period: ReportPeriod) => void;
}) => {
  const view = queryView(
    useQuery(timeReportOptions(organizationId, userId, filter)),
  );
  return (
    <ReportLayout
      data={view.type === "items" ? view.items : undefined}
      failed={view.type === "error"}
      feedback={
        queryViewError(view) === undefined ? undefined : (
          <QueryViewFeedback view={view} />
        )
      }
      filter={filter}
      period={period}
      onChange={onChange}
    />
  );
};

type ReportLayoutProps = {
  data: TimeReportResult | undefined;
  failed?: boolean;
  feedback?: ReactNode;
  filter: ReportFilter;
  period: ReportPeriod;
  onChange: (filter: ReportFilter, period: ReportPeriod) => void;
};
export const ReportLayout = ({
  data,
  failed,
  feedback,
  filter,
  period,
  onChange,
}: ReportLayoutProps) => {
  const t = useTranslations();
  const common = useTranslations("common");
  return (
    <ReportShell
      title={t(REPORT_LABELS.title)}
      privacy={t(REPORT_LABELS.privacy)}
      controls={
        <>
          <Tabs
            value={period}
            onValueChange={(value) => {
              if (isReportPeriod(value)) {
                onChange(
                  { ...filter, bucket: value === "week" ? "day" : "week" },
                  value,
                );
              }
            }}
          >
            <TabsList aria-label={t(REPORT_LABELS.period)}>
              {REPORT_PERIODS.map((value) => (
                <TabsTrigger key={value} value={value}>
                  {t(REPORT_LABELS[value])}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button
            aria-label={common("previous")}
            onClick={() =>
              onChange(
                { ...filter, ...shiftReportRange(filter, period, -1) },
                period,
              )
            }
            size="icon"
            variant="ghost"
          >
            <DirectionalIcon icon={ChevronLeftIcon} />
          </Button>
          <ReportControlField
            labelId="report-from"
            label={t(REPORT_LABELS.from)}
          >
            <DatePickerPopover
              labelledBy="report-from"
              value={filter.from}
              maxDate={filter.to}
              minDate={Temporal.PlainDate.from(filter.to)
                .subtract({ days: 365 })
                .toString()}
              onChange={(from) => {
                if (from) {
                  onChange({ ...filter, from }, "custom");
                }
              }}
            />
          </ReportControlField>
          <ReportControlField labelId="report-to" label={t(REPORT_LABELS.to)}>
            <DatePickerPopover
              labelledBy="report-to"
              value={filter.to}
              minDate={filter.from}
              maxDate={Temporal.PlainDate.from(filter.from)
                .add({ days: 365 })
                .toString()}
              onChange={(to) => {
                if (to) {
                  onChange({ ...filter, to }, "custom");
                }
              }}
            />
          </ReportControlField>
          <Button
            aria-label={common("next")}
            onClick={() =>
              onChange(
                { ...filter, ...shiftReportRange(filter, period, 1) },
                period,
              )
            }
            size="icon"
            variant="ghost"
          >
            <DirectionalIcon icon={ChevronRightIcon} />
          </Button>
          <ReportControlField
            labelId="report-rows"
            label={t(REPORT_LABELS.rows)}
          >
            <Select
              value={filter.groupBy}
              onValueChange={(groupBy) => {
                if (groupBy) {
                  onChange({ ...filter, groupBy }, period);
                }
              }}
            >
              <SelectTrigger aria-labelledby="report-rows">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {TIME_ENTRY_REPORT_GROUPS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(REPORT_LABELS[value])}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </ReportControlField>
          <ReportControlField
            labelId="report-columns"
            label={t(REPORT_LABELS.columns)}
          >
            <Select
              value={filter.bucket}
              onValueChange={(bucket) => {
                if (bucket) {
                  onChange({ ...filter, bucket }, period);
                }
              }}
            >
              <SelectTrigger aria-labelledby="report-columns">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {TIME_ENTRY_REPORT_BUCKETS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(REPORT_LABELS[value])}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </ReportControlField>
        </>
      }
    >
      {feedback}
      {data === undefined && !failed && (
        <ReportFiguresSkeleton filter={filter} />
      )}
      {data?.type === "too-large" && (
        <p className="text-sm" role="status">
          {t(REPORT_LABELS.tooLargeToLoad)}
        </p>
      )}
      {data?.type === "report" && (
        <>
          <ReportSummary data={data.report} />
          <ReportTable data={data.report} filter={filter} />
        </>
      )}
    </ReportShell>
  );
};
