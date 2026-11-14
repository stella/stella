import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronLeftIcon, ChevronRightIcon } from "@stll/ui/icons";

import {
  plainDateEpoch,
  SHORT_DATE,
} from "@/components/billing/format-plain-date";
import { shiftWeeks, weekOf } from "@/components/billing/work-week.logic";
import { DatePickerPopover } from "@/components/date-picker-popover";
import { useFormatter } from "@/i18n/formatting-context";

type WeekNavigatorProps = {
  /** Any day of the week on show. */
  date: string;
  onSelectDate: (date: string) => void;
  onToday: () => void;
};

/** Move a week at a time, or open the calendar to jump to any week. */
export const WeekNavigator = ({
  date,
  onSelectDate,
  onToday,
}: WeekNavigatorProps) => {
  const t = useTranslations("timesheets.week");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const week = weekOf(date);

  return (
    <div className="flex items-center gap-1">
      <Button onClick={onToday} size="sm" variant="outline">
        {tCommon("today")}
      </Button>
      <Button
        aria-label={t("previousWeek")}
        onClick={() => onSelectDate(shiftWeeks(date, -1))}
        size="icon-sm"
        variant="ghost"
      >
        <DirectionalIcon className="size-4" icon={ChevronLeftIcon} />
      </Button>
      {/* A steady width keeps the arrows under the pointer between weeks. */}
      <div className="flex min-w-36 justify-center tabular-nums">
        <DatePickerPopover
          className="w-auto"
          hideClear
          onChange={(value) => {
            if (value !== null) {
              onSelectDate(value);
            }
          }}
          showIcon={false}
          triggerLabel={t("range", {
            start: format.dateTime(plainDateEpoch(week.start), SHORT_DATE),
            end: format.dateTime(plainDateEpoch(week.end), SHORT_DATE),
          })}
          value={date}
        />
      </div>
      <Button
        aria-label={t("nextWeek")}
        onClick={() => onSelectDate(shiftWeeks(date, 1))}
        size="icon-sm"
        variant="ghost"
      >
        <DirectionalIcon className="size-4" icon={ChevronRightIcon} />
      </Button>
    </div>
  );
};
