import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";

import { getMonthLabels } from "./calendar-utils";

type CalendarHeaderProps = {
  headerLabel: string;
  year: number;
  month: number;
  onNavigatePrev: () => void;
  onNavigateNext: () => void;
  onNavigateToday: () => void;
  onSetViewDate: (date: Date) => void;
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
      <Button onClick={onNavigatePrev} size="icon-sm" variant="ghost">
        <ChevronLeftIcon />
      </Button>
      <Button onClick={onNavigateNext} size="icon-sm" variant="ghost">
        <ChevronRightIcon />
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
              onClick={() =>
                onSetViewDate(new Date(Date.UTC(year - 1, month, 1)))
              }
              size="icon-xs"
              variant="ghost"
            >
              <ChevronLeftIcon />
            </Button>
            <span className="text-xs font-medium">{year}</span>
            <Button
              onClick={() =>
                onSetViewDate(new Date(Date.UTC(year + 1, month, 1)))
              }
              size="icon-xs"
              variant="ghost"
            >
              <ChevronRightIcon />
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {monthPickerMonths.map((label, i) => (
              <Button
                data-pressed={i === month ? true : undefined}
                key={label}
                onClick={() => onSetViewDate(new Date(Date.UTC(year, i, 1)))}
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
