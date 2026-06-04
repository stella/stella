import { Suspense, useState } from "react";

import { createFileRoute } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";

import { ExpenseListView } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/expense-list-view";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/expenses",
)({
  component: ExpensesPage,
});

const formatDateISO = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const getMonday = (date: Date): Date => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d;
};

const addDays = (d: Date, n: number): Date => {
  const result = new Date(d);
  result.setDate(result.getDate() + n);
  return result;
};

function ExpensesPage() {
  const t = useTranslations();
  const workspaceId = Route.useParams({
    select: (p) => p.workspaceId,
  });

  const [currentDate, setCurrentDate] = useState(() => new Date());

  // Show expenses for the current week
  const monday = getMonday(currentDate);
  const sunday = addDays(monday, 6);
  const dateFrom = formatDateISO(monday);
  const dateTo = formatDateISO(sunday);

  const navigateWeek = (delta: number) => {
    setCurrentDate((d) => addDays(d, delta * 7));
  };

  const goToToday = () => {
    setCurrentDate(new Date());
  };

  const dateLabel = `${monday.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })} – ${sunday.toLocaleDateString(undefined, {
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
              className="size-7"
              onClick={() => navigateWeek(-1)}
              size="icon"
              variant="ghost"
            >
              <ChevronLeftIcon className="size-4" />
            </Button>
            <span className="min-w-[10rem] text-center text-sm">
              {dateLabel}
            </span>
            <Button
              className="size-7"
              onClick={() => navigateWeek(1)}
              size="icon"
              variant="ghost"
            >
              <ChevronRightIcon className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        <Suspense
          fallback={
            <div className="text-muted-foreground py-8 text-center text-sm">
              {t("billing.loading")}
            </div>
          }
        >
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
