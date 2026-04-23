"use client";

import { useMemo, useState } from "react";

import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { Button } from "@stella/ui/components/button";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stella/ui/components/popover";
import { cn } from "@stella/ui/lib/utils";

// -- Calendar utilities (self-contained, no external deps) --

type CalendarDay = {
  date: string;
  isCurrentMonth: boolean;
  isToday: boolean;
};

const toISODate = (d: Date): string => d.toISOString().slice(0, 10);

const getMonthDays = (year: number, month: number): CalendarDay[] => {
  const today = toISODate(new Date());
  const days: CalendarDay[] = [];
  const first = new Date(Date.UTC(year, month, 1));
  const startDow = (first.getUTCDay() + 6) % 7;
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - startDow);

  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = toISODate(d);
    days.push({
      date: iso,
      isCurrentMonth: d.getUTCMonth() === month,
      isToday: iso === today,
    });
  }
  return days;
};

const getWeekdayLabels = (locale: string): string[] => {
  const fmt = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    timeZone: "UTC",
  });
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.UTC(2024, 0, 1 + i));
    return fmt.format(d);
  });
};

const formatMonthYear = (locale: string, year: number, month: number): string =>
  new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month, 1)));

/** Normalize a Date | string | null to YYYY-MM-DD or "". */
const normalizeDate = (v: string | Date | null | undefined): string => {
  if (v === null || v === undefined) {
    return "";
  }
  if (v instanceof Date) {
    return v.toISOString().slice(0, 10);
  }
  return v.length >= 10 ? v.slice(0, 10) : v;
};

// -- Component --

type DatePickerPopoverProps = {
  value: string | Date | null;
  onChange: (value: string | null) => void;
  /** Locale string for formatting (e.g. "en", "cs"). Defaults to browser locale. */
  locale?: string;
  /** Show overdue styling (red text). */
  isOverdue?: boolean;
  /** Label for the clear button. Defaults to "Clear date". */
  clearLabel?: string;
  /** Label shown when overdue. Only shown when isOverdue is true. */
  overdueLabel?: string;
};

function DatePickerPopover({
  value: rawValue,
  onChange,
  locale: localeProp,
  isOverdue = false,
  clearLabel = "Clear date",
  overdueLabel,
}: DatePickerPopoverProps) {
  const locale = localeProp ?? navigator.language;
  const value = normalizeDate(rawValue);

  const [viewYear, setViewYear] = useState(() => {
    const d = value ? new Date(`${value}T00:00:00Z`) : new Date();
    return d.getUTCFullYear();
  });
  const [viewMonth, setViewMonth] = useState(() => {
    const d = value ? new Date(`${value}T00:00:00Z`) : new Date();
    return d.getUTCMonth();
  });

  const days = useMemo(
    () => getMonthDays(viewYear, viewMonth),
    [viewYear, viewMonth],
  );
  const weekdays = useMemo(() => getWeekdayLabels(locale), [locale]);
  const monthLabel = formatMonthYear(locale, viewYear, viewMonth);

  const navigatePrev = () => {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const navigateNext = () => {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const displayLabel = value
    ? new Date(`${value}T00:00:00Z`).toLocaleDateString(locale, {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : "\u2014";

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            className={cn(
              "flex h-7 w-full items-center gap-1.5",
              "rounded-md px-1.5 text-sm",
              "hover:bg-muted transition-colors",
              isOverdue
                ? "text-red-500"
                : value
                  ? "text-foreground"
                  : "text-muted-foreground",
            )}
            type="button"
          />
        }
      >
        <CalendarIcon className="size-3.5 shrink-0" />
        <span>{displayLabel}</span>
        {isOverdue && overdueLabel && (
          <span className="text-xs text-red-500">{overdueLabel}</span>
        )}
      </PopoverTrigger>
      <PopoverPopup
        className="*:data-[slot=popover-viewport]:p-2!"
        side="bottom"
      >
        <div className="w-56">
          <div className="flex items-center justify-between pb-1">
            <Button onClick={navigatePrev} size="icon-xs" variant="ghost">
              <ChevronLeftIcon />
            </Button>
            <span className="text-xs font-medium">{monthLabel}</span>
            <Button onClick={navigateNext} size="icon-xs" variant="ghost">
              <ChevronRightIcon />
            </Button>
          </div>

          <div className="grid grid-cols-7 gap-0">
            {weekdays.map((wd) => (
              <span
                className="text-muted-foreground py-1 text-center text-[10px]"
                key={wd}
              >
                {wd}
              </span>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-0">
            {days.map((day) => {
              const isSelected = day.date === value;
              return (
                <button
                  className={cn(
                    "flex size-8 items-center justify-center",
                    "rounded-full text-xs transition-colors",
                    "hover:bg-muted",
                    !day.isCurrentMonth && "text-muted-foreground/40",
                    day.isToday &&
                      !isSelected &&
                      "ring-foreground font-medium ring-1",
                    isSelected &&
                      "bg-primary text-primary-foreground hover:bg-primary/90",
                  )}
                  key={day.date}
                  onClick={() => onChange(day.date)}
                  type="button"
                >
                  {Number.parseInt(day.date.slice(8), 10)}
                </button>
              );
            })}
          </div>

          {value && (
            <div className="mt-1 border-t pt-1">
              <Button
                className="w-full"
                onClick={() => onChange(null)}
                size="xs"
                variant="ghost"
              >
                {clearLabel}
              </Button>
            </div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export { DatePickerPopover };
export type { DatePickerPopoverProps };
