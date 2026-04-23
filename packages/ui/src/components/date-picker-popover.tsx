"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { Button } from "@stella/ui/components/button";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stella/ui/components/popover";
import { cn } from "@stella/ui/lib/utils";

// ---------------------------------------------------------------------------
// Calendar utilities (self-contained, no external deps)
// ---------------------------------------------------------------------------

type CalendarDay = {
  date: string;
  isCurrentMonth: boolean;
  isToday: boolean;
};

const toISODate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Detect the first day of week for a locale via `Intl.Locale`.
 * Returns 0 = Monday .. 6 = Sunday (ISO week numbering).
 * Falls back to Monday when the API is unavailable.
 */
const getFirstDayOfWeek = (locale: string): number => {
  try {
    const loc = new Intl.Locale(locale);
    // getWeekInfo() returns { firstDay: 1–7 } where 1 = Mon, 7 = Sun
    const info =
      typeof loc.getWeekInfo === "function" ? loc.getWeekInfo() : undefined;
    if (info) {
      // Convert 1-7 (Mon=1, Sun=7) to 0-6 (Mon=0, Sun=6)
      return info.firstDay === 7 ? 6 : info.firstDay - 1;
    }
  } catch {
    // Intl.Locale not supported; fall back to Monday
  }
  return 0;
};

const getMonthDays = (
  year: number,
  month: number,
  firstDow: number,
): CalendarDay[] => {
  const today = toISODate(new Date());
  const days: CalendarDay[] = [];
  const first = new Date(Date.UTC(year, month, 1));
  // Shift so that firstDow lands in column 0
  const rawDow = first.getUTCDay(); // 0=Sun..6=Sat
  // Convert rawDow to Mon=0..Sun=6 then offset by firstDow
  const mondayBased = (rawDow + 6) % 7;
  const startOffset = (mondayBased - firstDow + 7) % 7;
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - startOffset);

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

const getWeekdayLabels = (locale: string, firstDow: number): string[] => {
  const fmt = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    timeZone: "UTC",
  });
  // 2024-01-01 is a Monday (dow 0 in our system)
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.UTC(2024, 0, 1 + ((i + firstDow) % 7)));
    return fmt.format(d);
  });
};

const getMonthLabels = (locale: string): string[] => {
  const fmt = new Intl.DateTimeFormat(locale, {
    month: "long",
    timeZone: "UTC",
  });
  return Array.from({ length: 12 }, (_, i) =>
    fmt.format(new Date(Date.UTC(2024, i, 1))),
  );
};

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

/** Add days to an ISO date string and return the new ISO string. */
const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return toISODate(d);
};

/** Compare ISO date strings. */
const isBefore = (a: string, b: string): boolean => a < b;
const isAfter = (a: string, b: string): boolean => a > b;

// Year range for the year dropdown: 100 years back, 20 years forward
const YEAR_RANGE_BACK = 100;
const YEAR_RANGE_FORWARD = 20;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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
  /** Earliest selectable date (YYYY-MM-DD). Days before this are disabled. */
  minDate?: string;
  /** Latest selectable date (YYYY-MM-DD). Days after this are disabled. */
  maxDate?: string;
  /** Callback to disable specific dates. Return true to disable. */
  isDateDisabled?: (date: string) => boolean;
};

function DatePickerPopover({
  value: rawValue,
  onChange,
  locale: localeProp,
  isOverdue = false,
  clearLabel = "Clear date",
  overdueLabel,
  minDate,
  maxDate,
  isDateDisabled,
}: DatePickerPopoverProps) {
  const locale = localeProp ?? navigator.language;
  const value = normalizeDate(rawValue);

  const firstDow = useMemo(() => getFirstDayOfWeek(locale), [locale]);

  const [viewYear, setViewYear] = useState(() => {
    const d = value ? new Date(`${value}T00:00:00Z`) : new Date();
    return d.getUTCFullYear();
  });
  const [viewMonth, setViewMonth] = useState(() => {
    const d = value ? new Date(`${value}T00:00:00Z`) : new Date();
    return d.getUTCMonth();
  });

  const days = useMemo(
    () => getMonthDays(viewYear, viewMonth, firstDow),
    [viewYear, viewMonth, firstDow],
  );
  const weekdays = useMemo(
    () => getWeekdayLabels(locale, firstDow),
    [locale, firstDow],
  );
  const monthLabels = useMemo(() => getMonthLabels(locale), [locale]);

  // Focused date for keyboard navigation (within the grid)
  const [focusedDate, setFocusedDate] = useState("");
  const gridRef = useRef<HTMLDivElement>(null);

  const navigateMonth = useCallback((delta: number) => {
    setViewMonth((m) => {
      const next = m + delta;
      if (next < 0) {
        setViewYear((y) => y - 1);
        return 11;
      }
      if (next > 11) {
        setViewYear((y) => y + 1);
        return 0;
      }
      return next;
    });
  }, []);

  const isDayDisabled = useCallback(
    (date: string): boolean => {
      if (minDate && isBefore(date, minDate)) {
        return true;
      }
      if (maxDate && isAfter(date, maxDate)) {
        return true;
      }
      if (isDateDisabled?.(date)) {
        return true;
      }
      return false;
    },
    [minDate, maxDate, isDateDisabled],
  );

  const displayLabel = value
    ? new Date(`${value}T00:00:00Z`).toLocaleDateString(locale, {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : "\u2014";

  // Format a date for screen reader labels
  const formatDayLabel = useCallback(
    (iso: string): string =>
      new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }),
    [locale],
  );

  // Keyboard handler for the day grid
  const handleGridKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const firstDay = days.at(0);
      if (!firstDay) {
        return;
      }
      const current = focusedDate || value || firstDay.date;
      let next: string | null = null;

      if (e.key === "ArrowRight") {
        next = addDays(current, 1);
      } else if (e.key === "ArrowLeft") {
        next = addDays(current, -1);
      } else if (e.key === "ArrowDown") {
        next = addDays(current, 7);
      } else if (e.key === "ArrowUp") {
        next = addDays(current, -7);
      } else if (e.key === "Home") {
        // First day of current week
        const dow = (new Date(`${current}T00:00:00Z`).getUTCDay() + 6) % 7;
        const offset = (dow - firstDow + 7) % 7;
        next = addDays(current, -offset);
      } else if (e.key === "End") {
        // Last day of current week
        const dow = (new Date(`${current}T00:00:00Z`).getUTCDay() + 6) % 7;
        const offset = (dow - firstDow + 7) % 7;
        next = addDays(current, 6 - offset);
      } else if (e.key === "PageUp") {
        if (e.shiftKey) {
          // Previous year
          const d = new Date(`${current}T00:00:00Z`);
          d.setUTCFullYear(d.getUTCFullYear() - 1);
          next = toISODate(d);
        } else {
          // Previous month
          const d = new Date(`${current}T00:00:00Z`);
          d.setUTCMonth(d.getUTCMonth() - 1);
          next = toISODate(d);
        }
      } else if (e.key === "PageDown") {
        if (e.shiftKey) {
          // Next year
          const d = new Date(`${current}T00:00:00Z`);
          d.setUTCFullYear(d.getUTCFullYear() + 1);
          next = toISODate(d);
        } else {
          // Next month
          const d = new Date(`${current}T00:00:00Z`);
          d.setUTCMonth(d.getUTCMonth() + 1);
          next = toISODate(d);
        }
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (!isDayDisabled(current)) {
          onChange(current);
        }
        return;
      } else {
        return;
      }

      e.preventDefault();
      if (next) {
        setFocusedDate(next);
        // Adjust viewMonth/viewYear if focused date moves out of view
        const nextDate = new Date(`${next}T00:00:00Z`);
        const nextMonth = nextDate.getUTCMonth();
        const nextYear = nextDate.getUTCFullYear();
        if (nextMonth !== viewMonth || nextYear !== viewYear) {
          setViewMonth(nextMonth);
          setViewYear(nextYear);
        }
        // Focus the button after render
        requestAnimationFrame(() => {
          const btn = gridRef.current?.querySelector<HTMLButtonElement>(
            `[data-date="${next}"]`,
          );
          btn?.focus();
        });
      }
    },
    [
      focusedDate,
      value,
      days,
      firstDow,
      viewMonth,
      viewYear,
      isDayDisabled,
      onChange,
    ],
  );

  // Year range for dropdown
  const currentYear = new Date().getUTCFullYear();
  const yearStart = currentYear - YEAR_RANGE_BACK;
  const yearEnd = currentYear + YEAR_RANGE_FORWARD;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            aria-label={value ? displayLabel : undefined}
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
        sideOffset={4}
      >
        <div className="w-60" role="dialog" aria-label="Date picker">
          {/* Month/year navigation with dropdowns */}
          <div className="flex items-center justify-between gap-1 pb-1">
            <Button
              aria-label="Previous month"
              onClick={() => navigateMonth(-1)}
              size="icon-xs"
              variant="ghost"
            >
              <ChevronLeftIcon />
            </Button>
            <div className="flex items-center gap-1">
              <select
                aria-label="Month"
                className="hover:text-foreground cursor-pointer bg-transparent text-xs font-medium outline-none"
                onChange={(e) => setViewMonth(Number(e.target.value))}
                value={viewMonth}
              >
                {monthLabels.map((label, i) => (
                  <option key={label} value={i}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Year"
                className="hover:text-foreground cursor-pointer bg-transparent text-xs font-medium outline-none"
                onChange={(e) => setViewYear(Number(e.target.value))}
                value={viewYear}
              >
                {Array.from({ length: yearEnd - yearStart + 1 }, (_, i) => {
                  const y = yearStart + i;
                  return (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  );
                })}
              </select>
            </div>
            <Button
              aria-label="Next month"
              onClick={() => navigateMonth(1)}
              size="icon-xs"
              variant="ghost"
            >
              <ChevronRightIcon />
            </Button>
          </div>

          {/* Weekday headers */}
          <div className="grid grid-cols-7 gap-0" role="row" aria-hidden="true">
            {weekdays.map((wd) => (
              <span
                className="text-muted-foreground py-1 text-center text-[10px]"
                key={wd}
              >
                {wd}
              </span>
            ))}
          </div>

          {/* Day grid */}
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
          <div
            aria-label={`${monthLabels[viewMonth]} ${viewYear}`}
            className="grid grid-cols-7 gap-0"
            onKeyDown={handleGridKeyDown}
            ref={gridRef}
            role="grid"
          >
            {days.map((day) => {
              const isSelected = day.date === value;
              const isFocused =
                day.date === focusedDate ||
                (!focusedDate && isSelected) ||
                (!focusedDate && !value && day.isToday);
              const disabled = isDayDisabled(day.date);

              return (
                <button
                  aria-current={day.isToday ? "date" : undefined}
                  aria-disabled={disabled || undefined}
                  aria-label={formatDayLabel(day.date)}
                  aria-selected={isSelected || undefined}
                  className={cn(
                    "flex size-8 items-center justify-center",
                    "rounded-full text-xs transition-colors",
                    "focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none",
                    disabled
                      ? "text-muted-foreground/30 cursor-not-allowed"
                      : "hover:bg-muted cursor-pointer",
                    !day.isCurrentMonth &&
                      !disabled &&
                      "text-muted-foreground/40",
                    day.isToday &&
                      !isSelected &&
                      !disabled &&
                      "ring-foreground font-medium ring-1",
                    isSelected &&
                      "bg-primary text-primary-foreground hover:bg-primary/90",
                  )}
                  data-date={day.date}
                  key={day.date}
                  onClick={() => {
                    if (!disabled) {
                      onChange(day.date);
                    }
                  }}
                  role="gridcell"
                  tabIndex={isFocused ? 0 : -1}
                  type="button"
                >
                  {Number.parseInt(day.date.slice(8), 10)}
                </button>
              );
            })}
          </div>

          {/* Clear button */}
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
