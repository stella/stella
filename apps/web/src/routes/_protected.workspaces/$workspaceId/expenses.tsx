import { Suspense, useState } from "react";

import { createFileRoute, redirect } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { DirectionalIcon } from "@stll/ui/components/directional-icon";
import { Skeleton } from "@stll/ui/components/skeleton";

import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { useLocale } from "@/i18n/formatting-context";
import { getFormattingLocale } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { prefetchRouteQuery } from "@/lib/react-query";
import { ExpenseListView } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/expense-list-view";
import {
  addDays,
  expensesOptions,
  getExpensesWeekRange,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/expenses";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/expenses",
)({
  beforeLoad: ({ params }) => {
    if (!isTimeBillingRouteEnabled()) {
      throw redirect({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: params.workspaceId },
      });
    }
  },
  loader: ({ context, params }) => {
    // Prefetch the current week's expenses using the exact same range
    // derivation (`getExpensesWeekRange`) the page component uses on mount,
    // so both compute an identical `expensesOptions` cache key and the fetch
    // starts during navigation instead of after the component mounts and
    // suspends.
    const { dateFrom, dateTo } = getExpensesWeekRange(
      new Date(),
      getFormattingLocale(),
    );
    detached(
      prefetchRouteQuery(
        context.queryClient,
        expensesOptions(params.workspaceId, { dateFrom, dateTo }),
        (error: unknown) => {
          getAnalytics().captureError(error);
        },
      ),
      "loader",
    );
  },
  component: ExpensesPage,
});

const EXPENSE_ROW_KEYS = ["a", "b", "c", "d", "e", "f"];

// Mirrors ExpenseListView's rest layout: the summary bar (totals + add entry)
// above a list of expense rows, so only the values pop in once data lands.
const ExpenseListSkeleton = () => (
  <div className="flex flex-col gap-3">
    {/* Summary bar */}
    <div className="flex items-center justify-between">
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-8 w-28 rounded-md" />
    </div>

    {/* Expenses list */}
    <div className="flex flex-col gap-1.5">
      {EXPENSE_ROW_KEYS.map((key) => (
        <div
          className="flex items-center gap-3 rounded-md border px-3 py-2"
          key={key}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-14 rounded" />
              <Skeleton className="h-4 w-12 rounded" />
            </div>
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-4 w-20 shrink-0" />
        </div>
      ))}
    </div>
  </div>
);

function ExpensesPage() {
  const t = useTranslations();
  const locale = useLocale();
  const workspaceId = Route.useParams({
    select: (p) => p.workspaceId,
  });

  const [currentDate, setCurrentDate] = useState(() => new Date());

  // Show expenses for the current week. Shared with the route `loader`'s
  // prefetch (see `getExpensesWeekRange`) so a cold navigation's initial
  // render derives the identical `expensesOptions` cache key.
  const { monday, sunday, dateFrom, dateTo } = getExpensesWeekRange(
    currentDate,
    locale,
  );

  const navigateWeek = (delta: number) => {
    setCurrentDate((d) => addDays(d, delta * 7));
  };

  const goToToday = () => {
    setCurrentDate(new Date());
  };

  const dateLabel = `${monday.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
  })} – ${sunday.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h1 className="text-sm font-medium">{t("common.expenses")}</h1>

        <div className="flex items-center gap-2">
          <Button onClick={goToToday} size="sm" variant="outline">
            {t("common.today")}
          </Button>
          <div className="flex items-center">
            <Button
              aria-label={t("common.previous")}
              className="size-7"
              onClick={() => navigateWeek(-1)}
              size="icon"
              variant="ghost"
            >
              <DirectionalIcon className="size-4" icon={ChevronLeftIcon} />
            </Button>
            <span className="min-w-[10rem] text-center text-sm">
              {dateLabel}
            </span>
            <Button
              aria-label={t("common.next")}
              className="size-7"
              onClick={() => navigateWeek(1)}
              size="icon"
              variant="ghost"
            >
              <DirectionalIcon className="size-4" icon={ChevronRightIcon} />
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        <Suspense fallback={<ExpenseListSkeleton />}>
          <ExpenseListView
            dateFrom={dateFrom}
            dateTo={dateTo}
            workspaceId={workspaceId}
          />
        </Suspense>
      </div>
    </div>
  );
}
