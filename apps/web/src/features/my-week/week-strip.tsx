import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { FaceLabelPending } from "@stll/ui/control-face";
import { cn } from "@stll/ui/utils";

import { plainDateEpoch } from "@/components/billing/format-plain-date";
import type { Week } from "@/components/billing/work-week.logic";
import type { WeekTotals } from "@/features/my-week/my-week.logic";
import {
  WEEK_STRIP_DATE,
  WeekStripDay,
  WeekStripLayout,
} from "@/features/my-week/week-strip.pending";
import { useFormatter } from "@/i18n/formatting-context";
import { formatMinutes } from "@/lib/workspaces/format-duration";

type WeekStripProps = {
  week: Week;
  selectedDate: string;
  totals: WeekTotals | undefined;
  pendingByDay: ReadonlyMap<string, number> | undefined;
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
    <WeekStripLayout label={t("days")}>
      {week.days.map((date) => {
        const selected = date === selectedDate;
        const pending = pendingByDay?.get(date) ?? 0;
        return (
          <li key={date}>
            <Button
              aria-current={selected ? "date" : undefined}
              className="group/plain flex w-full"
              onClick={() => onSelectDate(date)}
              variant="plain"
            >
              <WeekStripDay
                date={format.dateTime(plainDateEpoch(date), WEEK_STRIP_DATE)}
                selected={selected}
                durationLabel={
                  totals === undefined ? (
                    <FaceLabelPending className="w-8" />
                  ) : (
                    formatMinutes(totals.byDay.get(date) ?? 0)
                  )
                }
                pendingLabel={
                  pendingByDay === undefined ? (
                    <FaceLabelPending className="w-12" />
                  ) : (
                    <span className={cn(pending === 0 && "invisible")}>
                      {t("pendingCount", { count: pending })}
                    </span>
                  )
                }
              />
            </Button>
          </li>
        );
      })}
    </WeekStripLayout>
  );
};
