import { Suspense, useState } from "react";

import { createFileRoute, redirect } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Skeleton } from "@stll/ui/skeleton";

import { toISODate } from "@/components/workspaces/entity-utils";
import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { useLocale } from "@/i18n/formatting-context";
import { authClient } from "@/lib/auth";
import { roleOptions } from "@/lib/auth-queries";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
} from "@/lib/react-query";
import { MEDIUM_DATE_FORMAT } from "@/lib/relative-time";
import {
  timeEntriesInfiniteOptions,
  timeEntrySummaryOptions,
} from "@/lib/workspaces/queries/time-entries";
import { PersonalTimesheetDay } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/personal-timesheet-day";
import {
  getTimeEntryDateBounds,
  isTimeEntryDateAllowed,
} from "@/routes/_protected.workspaces/$workspaceId/-components/billing/time-entry-date.logic";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/timesheets",
)({
  beforeLoad: async ({ context, params }) => {
    if (!isTimeBillingRouteEnabled()) {
      throw redirect({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: params.workspaceId },
      });
    }

    const role = await ensureRouteQueryData(context.queryClient, roleOptions);
    const canReadTimeEntries = authClient.organization.checkRolePermission({
      role,
      permissions: { timeEntry: ["read"] },
    });
    if (!canReadTimeEntries) {
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
          dateFrom: today,
          dateTo: today,
          scope: "me",
        }),
      ),
      ensureRouteQueryData(
        context.queryClient,
        timeEntrySummaryOptions(params.workspaceId, today, today),
      ),
    ]);
  },
  remountDeps: ({ params }) => params.workspaceId,
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
  const tBilling = useTranslations("billing");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const workspaceId = Route.useParams({
    select: (params) => params.workspaceId,
  });
  const [date, setDate] = useState(() => new Date());
  const dateValue = toISODate(date);
  const dateBounds = getTimeEntryDateBounds();
  const canLogTime = isTimeEntryDateAllowed(dateValue, dateBounds);

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
        <h1 className="text-sm font-medium">{tBilling("timesheets")}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => setDate(new Date())}
            size="sm"
            variant="outline"
          >
            {tCommon("today")}
          </Button>
          <Button
            aria-label={tCommon("previous")}
            className="size-11"
            onClick={() => moveDay(-1)}
            size="icon"
            variant="ghost"
          >
            <DirectionalIcon className="size-4" icon={ChevronLeftIcon} />
          </Button>
          <span className="min-w-36 text-center text-sm">
            {date.toLocaleDateString(locale, MEDIUM_DATE_FORMAT)}
          </span>
          <Button
            aria-label={tCommon("next")}
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
            canCreateTimeEntry={canLogTime}
            date={dateValue}
            key={dateValue}
            workspaceId={workspaceId}
          />
        </Suspense>
      </div>
    </div>
  );
}
