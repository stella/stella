import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { WeekNavigator } from "@/components/billing/week-navigator";
import type { WeekTotals } from "@/features/my-week/my-week.logic";
import { formatMinutes } from "@/lib/workspaces/format-duration";

type MyWeekHeaderProps = {
  date: string;
  totals: WeekTotals;
  onSelectDate: (date: string) => void;
  onToday: () => void;
  /** Week-level actions, such as submitting the week once that step exists. */
  actions?: ReactNode;
};

export const MyWeekHeader = ({
  date,
  totals,
  onSelectDate,
  onToday,
  actions,
}: MyWeekHeaderProps) => {
  const t = useTranslations("timesheets.week");

  return (
    <header className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-1.5">
      <div className="min-w-0">
        <h1 className="text-sm font-medium">{t("title")}</h1>
        <p className="text-muted-foreground text-xs tabular-nums">
          {t("totals", {
            logged: formatMinutes(totals.loggedMinutes),
            billable: formatMinutes(totals.billableMinutes),
          })}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <WeekNavigator
          date={date}
          onSelectDate={onSelectDate}
          onToday={onToday}
        />
        {actions}
      </div>
    </header>
  );
};
