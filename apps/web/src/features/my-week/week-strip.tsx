import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import { plainDateEpoch } from "@/components/billing/format-plain-date";
import type { Week } from "@/components/billing/work-week.logic";
import type { WeekTotals } from "@/features/my-week/my-week.logic";
import { useFormatter } from "@/i18n/formatting-context";
import { formatMinutes } from "@/lib/workspaces/format-duration";

type WeekStripProps = {
  week: Week;
  selectedDate: string;
  totals: WeekTotals;
  pendingByDay: ReadonlyMap<string, number>;
  onSelectDate: (date: string) => void;
};

/** Monday to Sunday, each with its logged total; choosing one opens that day. */
export const WeekStrip = ({
  week,
  selectedDate,
  totals,
  pendingByDay,
  onSelectDate,
}: WeekStripProps) => {
  const t = useTranslations("timesheets.week");
  const format = useFormatter();

  return (
    <nav aria-label={t("days")} className="border-b px-4 py-2">
      <ol className="grid grid-cols-7 gap-1">
        {week.days.map((date) => {
          const selected = date === selectedDate;
          const pending = pendingByDay.get(date) ?? 0;
          return (
            <li key={date}>
              <Button
                aria-current={selected ? "date" : undefined}
                className="group/plain flex w-full"
                onClick={() => onSelectDate(date)}
                variant="plain"
              >
                <span
                  className={cn(
                    "flex min-h-14 w-full flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 text-center select-none",
                    selected
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground group-hover/plain:bg-muted/60",
                  )}
                >
                  <span className="text-xs">
                    {format.dateTime(plainDateEpoch(date), {
                      weekday: "short",
                      day: "numeric",
                      timeZone: "UTC",
                    })}
                  </span>
                  <span className="text-foreground text-sm font-medium tabular-nums">
                    {formatMinutes(totals.byDay.get(date) ?? 0)}
                  </span>
                  <span
                    className={cn(
                      "text-xs tabular-nums",
                      pending === 0 && "invisible",
                    )}
                  >
                    {t("pendingCount", { count: pending })}
                  </span>
                </span>
              </Button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
};
