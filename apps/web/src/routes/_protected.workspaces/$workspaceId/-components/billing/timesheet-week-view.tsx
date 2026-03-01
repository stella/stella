import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

import { formatMinutes } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/duration-input";
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

  // Group: matterId -> { day -> totalMinutes }
  const grid = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    if (!entries) {
      return map;
    }
    for (const entry of entries) {
      let dayMap = map.get(entry.matterId);
      if (!dayMap) {
        dayMap = new Map<string, number>();
        map.set(entry.matterId, dayMap);
      }
      const current = dayMap.get(entry.dateWorked) ?? 0;
      dayMap.set(entry.dateWorked, current + entry.durationMinutes);
    }
    return map;
  }, [entries]);

  const matterIds = Array.from(grid.keys());

  const columnTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const day of days) {
      let total = 0;
      for (const dayMap of grid.values()) {
        total += dayMap.get(day) ?? 0;
      }
      totals.set(day, total);
    }
    return totals;
  }, [grid, days]);

  const weekTotal = useMemo(
    () => Array.from(columnTotals.values()).reduce((sum, v) => sum + v, 0),
    [columnTotals],
  );

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
            <th className="sticky left-0 z-10 bg-background px-3 py-2 text-left font-medium">
              {t("billing.matter")}
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
                    <div className="text-xs text-muted-foreground">
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
            const rowTotal = days.reduce(
              (sum, day) => sum + (dayMap?.get(day) ?? 0),
              0,
            );

            return (
              <tr className="border-b hover:bg-muted/30" key={matterId}>
                <td className="sticky left-0 z-10 bg-background px-3 py-2 font-medium">
                  <span className="truncate">
                    {matterNameMap.get(matterId) ?? t("workspaces.defaultName")}
                  </span>
                </td>
                {days.map((day) => {
                  const mins = dayMap?.get(day) ?? 0;
                  return (
                    <td
                      className={cn(
                        "px-2 py-2 text-center tabular-nums",
                        day === today && "bg-primary/5",
                        mins === 0 && "text-muted-foreground/40",
                      )}
                      key={day}
                    >
                      {mins > 0 ? formatMinutes(mins) : "-"}
                    </td>
                  );
                })}
                <td className="px-2 py-2 text-center font-medium tabular-nums">
                  {formatMinutes(rowTotal)}
                </td>
              </tr>
            );
          })}
          {matterIds.length === 0 && (
            <tr>
              <td
                className="px-3 py-8 text-center text-muted-foreground"
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
              <td className="sticky left-0 z-10 bg-background px-3 py-2">
                {t("billing.total")}
              </td>
              {days.map((day) => (
                <td
                  className={cn(
                    "px-2 py-2 text-center tabular-nums",
                    day === today && "bg-primary/5",
                  )}
                  key={day}
                >
                  {formatMinutes(columnTotals.get(day) ?? 0)}
                </td>
              ))}
              <td className="px-2 py-2 text-center tabular-nums">
                {formatMinutes(weekTotal)}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
};
