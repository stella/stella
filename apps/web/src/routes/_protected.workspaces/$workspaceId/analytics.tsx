import { Suspense, useState } from "react";

import { createFileRoute } from "@tanstack/react-router";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { DateRangeFilter } from "@/routes/_protected.workspaces/$workspaceId/-components/analytics/date-range-filter";
import { HoursByMatterTable } from "@/routes/_protected.workspaces/$workspaceId/-components/analytics/hours-by-matter-table";
import { HoursByUserTable } from "@/routes/_protected.workspaces/$workspaceId/-components/analytics/hours-by-user-table";
import { HoursChart } from "@/routes/_protected.workspaces/$workspaceId/-components/analytics/hours-chart";
import { RevenueChart } from "@/routes/_protected.workspaces/$workspaceId/-components/analytics/revenue-chart";
import { SummaryCards } from "@/routes/_protected.workspaces/$workspaceId/-components/analytics/summary-cards";
import { formatDateISO } from "@/routes/_protected.workspaces/$workspaceId/-components/analytics/utils";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/analytics",
)({
  component: AnalyticsPage,
});

const getDefaultRange = () => {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
  return {
    dateFrom: formatDateISO(from),
    dateTo: formatDateISO(now),
  };
};

const LoadingFallback = () => (
  <div className="flex items-center justify-center py-12">
    <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
  </div>
);

function AnalyticsPage() {
  const t = useTranslations("analytics");
  const workspaceId = Route.useParams({ select: (p) => p.workspaceId });
  const defaults = getDefaultRange();
  const [dateFrom, setDateFrom] = useState(defaults.dateFrom);
  const [dateTo, setDateTo] = useState(defaults.dateTo);

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <DateRangeFilter
          dateFrom={dateFrom}
          dateTo={dateTo}
          onDateFromChange={setDateFrom}
          onDateToChange={setDateTo}
        />
      </div>

      <Suspense fallback={<LoadingFallback />}>
        <SummaryCards
          dateFrom={dateFrom}
          dateTo={dateTo}
          workspaceId={workspaceId}
        />
      </Suspense>

      <div className="grid gap-6 lg:grid-cols-2">
        <Suspense fallback={<LoadingFallback />}>
          <HoursChart
            dateFrom={dateFrom}
            dateTo={dateTo}
            workspaceId={workspaceId}
          />
        </Suspense>
        <Suspense fallback={<LoadingFallback />}>
          <RevenueChart
            dateFrom={dateFrom}
            dateTo={dateTo}
            workspaceId={workspaceId}
          />
        </Suspense>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Suspense fallback={<LoadingFallback />}>
          <HoursByMatterTable
            dateFrom={dateFrom}
            dateTo={dateTo}
            workspaceId={workspaceId}
          />
        </Suspense>
        <Suspense fallback={<LoadingFallback />}>
          <HoursByUserTable
            dateFrom={dateFrom}
            dateTo={dateTo}
            workspaceId={workspaceId}
          />
        </Suspense>
      </div>
    </div>
  );
}
