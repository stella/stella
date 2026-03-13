import { Suspense, useMemo, useState } from "react";

import { createFileRoute } from "@tanstack/react-router";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  DownloadIcon,
  SettingsIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";
import { Tabs, TabsList, TabsTab } from "@stella/ui/components/tabs";
import { toastManager } from "@stella/ui/components/toast";

import { api } from "@/lib/api";
import { BillingCodesDialog } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/billing-codes-dialog";
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

const downloadBlob = (content: string, filename: string) => {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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
  const [codesOpen, setCodesOpen] = useState(false);

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

  const handleExport = async (format: string) => {
    const dateFrom = view === "day" ? dateStr : weekStart;
    const dateTo = view === "day" ? dateStr : weekEnd;
    const query = { dateFrom, dateTo };

    if (format === "csv") {
      const response = await api["time-entries"]({
        workspaceId,
      }).export.csv.get({ query });
      if (response.error) {
        throw new Error("Export failed");
      }
      // SAFETY: CSV endpoint returns plain text string
      downloadBlob(response.data, `timesheet-${dateFrom}.csv`);
    } else if (format === "ledes") {
      const response = await api["time-entries"]({
        workspaceId,
      }).export.ledes.get({ query });
      if (response.error) {
        throw new Error("Export failed");
      }
      // SAFETY: LEDES endpoint returns plain text string
      downloadBlob(response.data, `timesheet-${dateFrom}.ledes`);
    } else if (format === "pdf") {
      const response = await api["time-entries"]({
        workspaceId,
      }).export.pdf.get({ query });
      if (response.error) {
        throw new Error("Export failed");
      }
      // SAFETY: PDF endpoint returns binary; Eden types it
      // as unknown but the response body is an ArrayBuffer
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const pdfData = response.data as unknown as ArrayBuffer;
      const blob = new Blob([pdfData], {
        type: "application/pdf",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `timesheet-${dateFrom}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-medium">{t("billing.timesheets")}</h1>
          <Tabs onValueChange={setView} value={view}>
            <TabsList>
              <TabsTab value="day">{t("billing.day")}</TabsTab>
              <TabsTab value="week">{t("billing.week")}</TabsTab>
            </TabsList>
          </Tabs>
          <Button onClick={() => setRatesOpen(true)} size="sm" variant="ghost">
            <SettingsIcon className="size-4" />
            {t("billing.rates.rates")}
          </Button>
          <Button onClick={() => setCodesOpen(true)} size="sm" variant="ghost">
            <CodeIcon className="size-4" />
            {t("billing.codes.manageCodes")}
          </Button>
        </div>

        <div className="flex items-center gap-2">
          {/* Export dropdown */}
          <Select
            onValueChange={(val) => {
              if (val) {
                handleExport(val).catch(() => {
                  toastManager.add({
                    title: t("errors.actionFailed"),
                    type: "error",
                  });
                });
              }
            }}
            value=""
          >
            <SelectTrigger size="sm">
              <DownloadIcon className="size-3.5" />
              <SelectValue placeholder={t("billing.export")} />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="csv">{t("billing.exportCSV")}</SelectItem>
              <SelectItem value="ledes">{t("billing.exportLEDES")}</SelectItem>
              <SelectItem value="pdf">{t("billing.exportPDF")}</SelectItem>
            </SelectPopup>
          </Select>

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
            <div className="text-muted-foreground py-8 text-center text-sm">
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

      <BillingCodesDialog
        onOpenChange={setCodesOpen}
        open={codesOpen}
        workspaceId={workspaceId}
      />
    </div>
  );
}
