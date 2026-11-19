import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { WeekNavigator } from "@/components/billing/week-navigator";
import { MyWeekTotalsSkeleton } from "@/features/my-week/my-week-day.pending";
import type { WeekTotals } from "@/features/my-week/my-week.logic";
import { formatMinutes } from "@/lib/workspaces/format-duration";
import { MyWeekHeaderFrame } from "@/routes/-my-week.pending";

type MyWeekHeaderProps = {
  date: string;
  totals: WeekTotals | undefined;
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
    <MyWeekHeaderFrame
      title={t("title")}
      totals={
        totals === undefined ? (
          <MyWeekTotalsSkeleton />
        ) : (
          t("totals", {
            logged: formatMinutes(totals.loggedMinutes),
            billable: formatMinutes(totals.billableMinutes),
          })
        )
      }
      navigator={
        <WeekNavigator
          date={date}
          onSelectDate={onSelectDate}
          onToday={onToday}
        />
      }
      actions={actions}
    />
  );
};
