import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronLeftIcon, ChevronRightIcon } from "@stll/ui/icons";

import {
  plainDateEpoch,
  SHORT_DATE,
} from "@/components/billing/format-plain-date";
import type { Week } from "@/components/billing/work-week.logic";
import type { WeekTotals } from "@/features/my-week/my-week.logic";
import { useFormatter } from "@/i18n/formatting-context";
import { formatMinutes } from "@/lib/workspaces/format-duration";

type MyWeekHeaderProps = {
  week: Week;
  totals: WeekTotals;
  onPreviousWeek: () => void;
  onNextWeek: () => void;
  onToday: () => void;
  /** Week-level actions, such as submitting the week once that step exists. */
  actions?: ReactNode;
};

export const MyWeekHeader = ({
  week,
  totals,
  onPreviousWeek,
  onNextWeek,
  onToday,
  actions,
}: MyWeekHeaderProps) => {
  const t = useTranslations("timesheets.week");
  const tCommon = useTranslations("common");
  const format = useFormatter();

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
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
        <Button onClick={onToday} size="sm" variant="outline">
          {tCommon("today")}
        </Button>
        <Button
          aria-label={t("previousWeek")}
          className="size-11"
          onClick={onPreviousWeek}
          size="icon"
          variant="ghost"
        >
          <DirectionalIcon className="size-4" icon={ChevronLeftIcon} />
        </Button>
        <span className="min-w-36 text-center text-sm tabular-nums">
          {t("range", {
            start: format.dateTime(plainDateEpoch(week.start), SHORT_DATE),
            end: format.dateTime(plainDateEpoch(week.end), SHORT_DATE),
          })}
        </span>
        <Button
          aria-label={t("nextWeek")}
          className="size-11"
          onClick={onNextWeek}
          size="icon"
          variant="ghost"
        >
          <DirectionalIcon className="size-4" icon={ChevronRightIcon} />
        </Button>
        {actions}
      </div>
    </header>
  );
};
