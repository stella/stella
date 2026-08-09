import { Suspense, useState } from "react";

import { createFileRoute, redirect } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { DirectionalIcon } from "@stll/ui/components/directional-icon";
import { Skeleton } from "@stll/ui/components/skeleton";

import { toISODate } from "@/components/workspaces/entity-utils";
import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { useLocale } from "@/i18n/formatting-context";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
} from "@/lib/react-query";
import {
  timeEntriesInfiniteOptions,
  timeEntrySummaryOptions,
} from "@/lib/workspaces/queries/time-entries";
import { PersonalTimesheetDay } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/personal-timesheet-day";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/timesheets",
)({
  beforeLoad: ({ params }) => {
    if (!isTimeBillingRouteEnabled()) {
      throw redirect({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: params.workspaceId },
      });
    }
  },
  loader: async ({ context, params }) => {
    const today = toISODate(new Date());
    await Promise.all([
      ensureRouteInfiniteQueryData(
        context.queryClient,
        timeEntriesInfiniteOptions(params.workspaceId, {
          userId: context.user.id,
          dateFrom: today,
          dateTo: today,
        }),
      ),
      ensureRouteQueryData(
        context.queryClient,
        timeEntrySummaryOptions(params.workspaceId, today, today),
      ),
    ]);
  },
  component: TimesheetsPage,
});

const TimesheetSkeleton = () => (
  <div className="flex flex-col gap-3">
    <div className="flex min-h-11 items-center justify-between">
      <Skeleton className="h-5 w-20" />
      <Skeleton className="h-9 w-28" />
    </div>
    {Array.from({ length: 3 }, (_, index) => (
      <Skeleton className="h-14 w-full rounded-lg" key={index} />
    ))}
  </div>
);

function TimesheetsPage() {
  const t = useTranslations();
  const locale = useLocale();
  const workspaceId = Route.useParams({
    select: (params) => params.workspaceId,
  });
  const [date, setDate] = useState(() => new Date());
  const dateValue = toISODate(date);

  const moveDay = (days: number) => {
    setDate((current) => {
      const next = new Date(current);
      next.setDate(next.getDate() + days);
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <h1 className="text-sm font-medium">{t("billing.timesheets")}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => setDate(new Date())}
            size="sm"
            variant="outline"
          >
            {t("common.today")}
          </Button>
          <Button
            aria-label={t("common.previous")}
            className="size-11"
            onClick={() => moveDay(-1)}
            size="icon"
            variant="ghost"
          >
            <DirectionalIcon className="size-4" icon={ChevronLeftIcon} />
          </Button>
          <span className="min-w-36 text-center text-sm">
            {date.toLocaleDateString(locale, {
              dateStyle: "medium",
            })}
          </span>
          <Button
            aria-label={t("common.next")}
            className="size-11"
            disabled={dateValue >= toISODate(new Date())}
            onClick={() => moveDay(1)}
            size="icon"
            variant="ghost"
          >
            <DirectionalIcon className="size-4" icon={ChevronRightIcon} />
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <Suspense fallback={<TimesheetSkeleton />}>
          <PersonalTimesheetDay
            date={dateValue}
            key={dateValue}
            workspaceId={workspaceId}
          />
        </Suspense>
      </div>
    </div>
  );
}
