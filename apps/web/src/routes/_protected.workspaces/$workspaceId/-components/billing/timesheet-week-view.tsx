import { useMemo } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { prorateHourlyCents } from "@stll/money";
import { cn } from "@stll/ui/lib/utils";

import {
  formatDecimalHours,
  formatMinutes,
} from "@/routes/_protected.workspaces/$workspaceId/-components/billing/duration-input";
import {
  DEFAULT_CURRENCY,
  formatCurrencyCompact,
} from "@/routes/_protected.workspaces/$workspaceId/-components/billing/format-currency";
import { useMatterNameMap } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/matter-name-map";
import { timeEntriesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/time-entries";

type TimesheetWeekViewProps = {
  workspaceId: string;
  weekStart: string;
  weekEnd: string;
  onDayClick: (date: string) => void;
};

const getDaysInRange = (start: string, end: string): string[] => {
  const days: string[] = [];
  const current = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  while (current <= endDate) {
    const y = current.getFullYear();
    const m = String(current.getMonth() + 1).padStart(2, "0");
    const day = String(current.getDate()).padStart(2, "0");
    days.push(`${y}-${m}-${day}`);
    current.setDate(current.getDate() + 1);
  }
  return days;
};

export const TimesheetWeekView = ({
  workspaceId,
  weekStart,
  weekEnd,
  onDayClick,
}: TimesheetWeekViewProps) => {
  const t = useTranslations();

  const { data: entries } = useSuspenseQuery(
    timeEntriesOptions(workspaceId, {
      dateFrom: weekStart,
      dateTo: weekEnd,
    }),
  );

  const matterNameMap = useMatterNameMap(workspaceId);

  const days = useMemo(
    () => getDaysInRange(weekStart, weekEnd),
    [weekStart, weekEnd],
  );

  // Grid: matterId -> { day -> { minutes, amount } }
  type DayData = { minutes: number; amount: number };
  const grid = useMemo(() => {
    const map = new Map<string, Map<string, DayData>>();
    if (entries === undefined) {
      return map;
    }
    for (const entry of entries) {
      let dayMap = map.get(entry.matterId);
      if (!dayMap) {
        dayMap = new Map<string, DayData>();
        map.set(entry.matterId, dayMap);
      }
      const current = dayMap.get(entry.dateWorked) ?? {
        minutes: 0,
        amount: 0,
      };
      current.minutes += entry.durationMinutes;
      if (entry.billable) {
        current.amount += prorateHourlyCents({
          billedMinutes: entry.billedMinutes,
          hourlyRateCents: entry.rateAtEntry,
        });
      }
      dayMap.set(entry.dateWorked, current);
    }
    return map;
  }, [entries]);

  // Find dominant currency
  const dominantCurrency = useMemo(() => {
    if (entries === undefined || entries.length === 0) {
      return DEFAULT_CURRENCY;
    }
    return entries.at(0)?.currency ?? DEFAULT_CURRENCY;
  }, [entries]);

  const matterIds = [...grid.keys()];

  const columnTotals = useMemo(() => {
    const totals = new Map<string, DayData>();
    for (const day of days) {
      let minutes = 0;
      let amount = 0;
      for (const dayMap of grid.values()) {
        const data = dayMap.get(day);
        if (data) {
          minutes += data.minutes;
          amount += data.amount;
        }
      }
      totals.set(day, { minutes, amount });
    }
    return totals;
  }, [grid, days]);

  const weekTotals = useMemo(() => {
    let minutes = 0;
    let amount = 0;
    for (const data of columnTotals.values()) {
      minutes += data.minutes;
      amount += data.amount;
    }
    return { minutes, amount };
  }, [columnTotals]);

  const today = useMemo(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }, []);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th className="bg-background sticky start-0 z-10 px-3 py-2 text-start font-medium">
              {t("common.matter")}
            </th>
            {days.map((day) => {
              const d = new Date(`${day}T00:00:00`);
              return (
                <th
                  className={cn(
                    "min-w-[5rem] px-2 py-2 text-center font-medium",
                    day === today && "bg-primary/5",
                  )}
                  key={day}
                >
                  <button
                    className="hover:underline"
                    onClick={() => onDayClick(day)}
                    type="button"
                  >
                    <div className="text-muted-foreground text-xs">
                      {d.toLocaleDateString(undefined, {
                        weekday: "short",
                      })}
                    </div>
                    <div>{d.getDate()}</div>
                  </button>
                </th>
              );
            })}
            <th className="min-w-[5rem] px-2 py-2 text-center font-medium">
              {t("billing.total")}
            </th>
          </tr>
        </thead>
        <tbody>
          {matterIds.map((matterId) => {
            const dayMap = grid.get(matterId);
            let rowMinutes = 0;
            let rowAmount = 0;
            for (const day of days) {
              const data = dayMap?.get(day);
              if (data) {
                rowMinutes += data.minutes;
                rowAmount += data.amount;
              }
            }

            return (
              <tr className="hover:bg-muted/30 border-b" key={matterId}>
                <td className="bg-background sticky start-0 z-10 px-3 py-2 font-medium">
                  <span className="truncate">
                    {matterNameMap.get(matterId) ?? t("workspaces.defaultName")}
                  </span>
                </td>
                {days.map((day) => {
                  const data = dayMap?.get(day);
                  const mins = data?.minutes ?? 0;
                  return (
                    <td
                      className={cn(
                        "px-2 py-2 text-center tabular-nums",
                        day === today && "bg-primary/5",
                        mins === 0 && "text-foreground-disabled",
                      )}
                      key={day}
                    >
                      {mins > 0 ? formatMinutes(mins) : "-"}
                    </td>
                  );
                })}
                <td className="px-2 py-2 text-center tabular-nums">
                  <div className="font-medium">{formatMinutes(rowMinutes)}</div>
                  {rowAmount > 0 && (
                    <div className="text-muted-foreground text-xs">
                      {formatCurrencyCompact(rowAmount, dominantCurrency)}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
          {matterIds.length === 0 && (
            <tr>
              <td
                className="text-muted-foreground px-3 py-8 text-center"
                colSpan={days.length + 2}
              >
                {t("billing.noEntries")}
              </td>
            </tr>
          )}
        </tbody>
        {matterIds.length > 0 && (
          <tfoot>
            <tr className="border-t font-medium">
              <td className="bg-background sticky start-0 z-10 px-3 py-2">
                {t("billing.total")}
              </td>
              {days.map((day) => {
                const data = columnTotals.get(day);
                return (
                  <td
                    className={cn(
                      "px-2 py-2 text-center tabular-nums",
                      day === today && "bg-primary/5",
                    )}
                    key={day}
                  >
                    {formatMinutes(data?.minutes ?? 0)}
                  </td>
                );
              })}
              <td className="px-2 py-2 text-center tabular-nums">
                <div>{formatMinutes(weekTotals.minutes)}</div>
                <div className="text-muted-foreground text-xs">
                  {t("billing.decimalHours", {
                    hours: formatDecimalHours(weekTotals.minutes),
                  })}
                </div>
                {weekTotals.amount > 0 && (
                  <div className="text-xs">
                    {formatCurrencyCompact(weekTotals.amount, dominantCurrency)}
                  </div>
                )}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
};
