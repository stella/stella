import { Suspense, useState } from "react";

import { createFileRoute } from "@tanstack/react-router";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  DateRangeFilter,
  getDefaultRange,
} from "@/routes/_protected.knowledge/-components/template-analytics/date-range-filter";
import { FillsByUserTable } from "@/routes/_protected.knowledge/-components/template-analytics/fills-by-user-table";
import { FillsChart } from "@/routes/_protected.knowledge/-components/template-analytics/fills-chart";
import { SummaryCards } from "@/routes/_protected.knowledge/-components/template-analytics/summary-cards";
import { TopTemplatesTable } from "@/routes/_protected.knowledge/-components/template-analytics/top-templates-table";

export const Route = createFileRoute("/_protected/knowledge/analytics")({
  component: TemplateAnalyticsPage,
});

const LoadingFallback = () => (
  <div className="flex items-center justify-center py-12">
    <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
  </div>
);

function TemplateAnalyticsPage() {
  const t = useTranslations("templateAnalytics");
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
        <SummaryCards dateFrom={dateFrom} dateTo={dateTo} />
      </Suspense>

      <Suspense fallback={<LoadingFallback />}>
        <FillsChart dateFrom={dateFrom} dateTo={dateTo} />
      </Suspense>

      <div className="grid gap-6 lg:grid-cols-2">
        <Suspense fallback={<LoadingFallback />}>
          <TopTemplatesTable dateFrom={dateFrom} dateTo={dateTo} />
        </Suspense>
        <Suspense fallback={<LoadingFallback />}>
          <FillsByUserTable dateFrom={dateFrom} dateTo={dateTo} />
        </Suspense>
      </div>
    </div>
  );
}
