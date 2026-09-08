import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";

import { useLocale } from "@/i18n/formatting-context";

import { getMonthLabels } from "./calendar-utils";

type CalendarHeaderProps = {
  headerLabel: string;
  year: number;
  month: number;
  onNavigatePrev: () => void;
  onNavigateNext: () => void;
  onNavigateToday: () => void;
  onSetViewDate: (date: Temporal.PlainDate) => void;
};

export const CalendarHeader = ({
  headerLabel,
  year,
  month,
  onNavigatePrev,
  onNavigateNext,
  onNavigateToday,
  onSetViewDate,
}: CalendarHeaderProps) => {
  const t = useTranslations();
  const locale = useLocale();

  const monthPickerMonths = getMonthLabels(locale, year, "short");

  return (
    <div className="flex min-w-0 items-center gap-2 px-4 py-2">
      <Button onClick={onNavigateToday} size="sm" variant="outline">
        {t("common.today")}
      </Button>
      <Button
        aria-label={t("common.previous")}
        onClick={onNavigatePrev}
        size="icon-sm"
        variant="ghost"
      >
        <DirectionalIcon icon={ChevronLeftIcon} />
      </Button>
      <Button
        aria-label={t("common.next")}
        onClick={onNavigateNext}
        size="icon-sm"
        variant="ghost"
      >
        <DirectionalIcon icon={ChevronRightIcon} />
      </Button>
      <Popover>
        <PopoverTrigger
          render={
            <button
              className="text-sm font-medium hover:underline"
              type="button"
            />
          }
        >
          {headerLabel}
        </PopoverTrigger>
        <PopoverPopup
          className="*:data-[slot=popover-viewport]:p-2!"
          side="bottom"
        >
          <div className="flex items-center justify-between pb-1">
            <Button
              aria-label={t("common.previous")}
              onClick={() =>
                onSetViewDate(
                  Temporal.PlainDate.from({
                    year: year - 1,
                    month: month + 1,
                    day: 1,
                  }),
                )
              }
              size="icon-xs"
              variant="ghost"
            >
              <DirectionalIcon icon={ChevronLeftIcon} />
            </Button>
            <span className="text-xs font-medium">{year}</span>
            <Button
              aria-label={t("common.next")}
              onClick={() =>
                onSetViewDate(
                  Temporal.PlainDate.from({
                    year: year + 1,
                    month: month + 1,
                    day: 1,
                  }),
                )
              }
              size="icon-xs"
              variant="ghost"
            >
              <DirectionalIcon icon={ChevronRightIcon} />
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {monthPickerMonths.map((label, i) => (
              <Button
                data-pressed={i === month ? true : undefined}
                key={label}
                onClick={() =>
                  onSetViewDate(
                    Temporal.PlainDate.from({ year, month: i + 1, day: 1 }),
                  )
                }
                size="xs"
                variant={i === month ? "secondary" : "ghost"}
              >
                {label}
              </Button>
            ))}
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
};
