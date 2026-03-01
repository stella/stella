import { Suspense, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon, SettingsIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Tabs, TabsList, TabsTab } from "@stella/ui/components/tabs";

import { RateManagementDialog } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/rate-management-dialog";
import { TimesheetDayView } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/timesheet-day-view";
import { TimesheetWeekView } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/timesheet-week-view";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/timesheets",
)({
  component: TimesheetsPage,
});

const getMonday = (date: Date): Date => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d;
};

const formatDateISO = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const addDays = (d: Date, n: number): Date => {
  const result = new Date(d);
  result.setDate(result.getDate() + n);
  return result;
};

function TimesheetsPage() {
  const t = useTranslations();
  const workspaceId = Route.useParams({
    select: (p) => p.workspaceId,
  });

  type ViewMode = "day" | "week";
  const [view, setView] = useState<ViewMode>("day");
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [ratesOpen, setRatesOpen] = useState(false);

  const dateStr = formatDateISO(currentDate);

  const monday = useMemo(() => getMonday(currentDate), [currentDate]);
  const weekStart = formatDateISO(monday);
  const weekEnd = formatDateISO(addDays(monday, 6));

  const navigateDay = (delta: number) => {
    setCurrentDate((d) => addDays(d, delta));
  };

  const navigateWeek = (delta: number) => {
    setCurrentDate((d) => addDays(d, delta * 7));
  };

  const goToToday = () => {
    setCurrentDate(new Date());
  };

  const dateLabel =
    view === "day"
      ? currentDate.toLocaleDateString(undefined, {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : `${monday.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        })} – ${addDays(monday, 6).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}`;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-medium">{t("billing.timesheets")}</h1>
          <Tabs
            onValueChange={(val) => {
              if (val === "day" || val === "week") {
                setView(val);
              }
            }}
            value={view}
          >
            <TabsList>
              <TabsTab value="day">{t("billing.day")}</TabsTab>
              <TabsTab value="week">{t("billing.week")}</TabsTab>
            </TabsList>
          </Tabs>
          <Button onClick={() => setRatesOpen(true)} size="sm" variant="ghost">
            <SettingsIcon className="size-4" />
            {t("billing.rates.rates")}
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={goToToday} size="sm" variant="outline">
            {t("billing.today")}
          </Button>
          <div className="flex items-center">
            <Button
              className="size-7"
              onClick={() =>
                view === "day" ? navigateDay(-1) : navigateWeek(-1)
              }
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
              onClick={() =>
                view === "day" ? navigateDay(1) : navigateWeek(1)
              }
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
            <div className="py-8 text-center text-sm text-muted-foreground">
              {t("billing.loading")}
            </div>
          }
        >
          {view === "day" ? (
            <TimesheetDayView date={dateStr} workspaceId={workspaceId} />
          ) : (
            <TimesheetWeekView
              onDayClick={(day) => {
                setCurrentDate(new Date(`${day}T00:00:00`));
                setView("day");
              }}
              weekEnd={weekEnd}
              weekStart={weekStart}
              workspaceId={workspaceId}
            />
          )}
        </Suspense>
      </div>

      <RateManagementDialog
        onOpenChange={setRatesOpen}
        open={ratesOpen}
        workspaceId={workspaceId}
      />
    </div>
  );
}
