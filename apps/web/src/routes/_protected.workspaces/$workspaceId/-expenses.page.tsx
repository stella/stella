import { Suspense, useState } from "react";

import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronLeftIcon, ChevronRightIcon } from "@stll/ui/icons";

import { WeekNavigatorFrame } from "@/components/billing/week-navigator.pending";
import { useFormatter, useFormattingLocale } from "@/i18n/formatting-context";
import {
  CALENDAR_DATE_FORMAT,
  DAY_AND_MONTH_FORMAT,
} from "@/lib/relative-time";
import { getExpensesWeekRange } from "@/lib/workspaces/queries/expenses";
import { ExpenseListView } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/expense-list-view";

import { ExpenseListSkeleton, ExpensesShell } from "./-expenses.pending";

const routeApi = getRouteApi("/_protected/workspaces/$workspaceId/expenses");

export function ExpensesPage() {
  const t = useTranslations();
  const format = useFormatter();
  const locale = useFormattingLocale();
  const workspaceId = routeApi.useParams({
    select: (p) => p.workspaceId,
  });

  const [currentDate, setCurrentDate] = useState(() =>
    Temporal.Now.instant()
      .toZonedDateTimeISO(Temporal.Now.timeZoneId())
      .toPlainDate(),
  );

  // Show expenses for the current week. Shared with the route `loader`'s
  // prefetch (see `getExpensesWeekRange`) so a cold navigation's initial
  // render derives the identical `expensesOptions` cache key.
  const { monday, sunday, dateFrom, dateTo } = getExpensesWeekRange(
    currentDate,
    locale,
  );

  const navigateWeek = (delta: number) => {
    setCurrentDate((d) => d.add({ days: delta * 7 }));
  };

  const goToToday = () => {
    setCurrentDate(
      Temporal.Now.instant()
        .toZonedDateTimeISO(Temporal.Now.timeZoneId())
        .toPlainDate(),
    );
  };

  const dateLabel = `${format.dateTime(
    monday.toZonedDateTime({
      plainTime: Temporal.PlainTime.from("00:00"),
      timeZone: "UTC",
    }).epochMilliseconds,
    { ...DAY_AND_MONTH_FORMAT, timeZone: "UTC" },
  )} – ${format.dateTime(
    sunday.toZonedDateTime({
      plainTime: Temporal.PlainTime.from("00:00"),
      timeZone: "UTC",
    }).epochMilliseconds,
    { ...CALENDAR_DATE_FORMAT, timeZone: "UTC" },
  )}`;

  return (
    <ExpensesShell
      navigator={
        <WeekNavigatorFrame
          today={
            <Button onClick={goToToday} size="sm" variant="outline">
              {t("common.today")}
            </Button>
          }
          previous={
            <Button
              aria-label={t("common.previous")}
              className="size-7"
              onClick={() => navigateWeek(-1)}
              size="icon"
              variant="ghost"
            >
              <DirectionalIcon className="size-4" icon={ChevronLeftIcon} />
            </Button>
          }
          range={<span className="text-sm">{dateLabel}</span>}
          next={
            <Button
              aria-label={t("common.next")}
              className="size-7"
              onClick={() => navigateWeek(1)}
              size="icon"
              variant="ghost"
            >
              <DirectionalIcon className="size-4" icon={ChevronRightIcon} />
            </Button>
          }
        />
      }
    >
      <Suspense fallback={<ExpenseListSkeleton />}>
        <ExpenseListView
          dateFrom={dateFrom}
          dateTo={dateTo}
          workspaceId={workspaceId}
        />
      </Suspense>
    </ExpensesShell>
  );
}
