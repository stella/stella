"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { Button } from "@stll/ui/components/button";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { cn } from "@stll/ui/lib/utils";

// ---------------------------------------------------------------------------
// Calendar utilities
// ---------------------------------------------------------------------------

type CalendarDay = {
  date: string;
  isCurrentMonth: boolean;
  isToday: boolean;
  isWeekend: boolean;
};

type CalendarWeekday = {
  isWeekend: boolean;
  label: string;
};

const toISODate = (d: Date): string => d.toISOString().slice(0, 10);
const DEFAULT_WEEKEND_DAYS = new Set([0, 6]); // Sunday, Saturday

const getFirstDayOfWeek = (locale: string): number => {
  try {
    const loc = new Intl.Locale(locale);
    const info =
      typeof loc.getWeekInfo === "function" ? loc.getWeekInfo() : undefined;
    if (info) {
      return info.firstDay === 7 ? 6 : info.firstDay - 1;
    }
  } catch {
    // fall back to Monday
  }
  return 0;
};

const getWeekendDays = (locale: string): ReadonlySet<number> => {
  try {
    const loc = new Intl.Locale(locale);
    const info =
      typeof loc.getWeekInfo === "function" ? loc.getWeekInfo() : undefined;
    const weekend = info?.weekend;
    if (Array.isArray(weekend) && weekend.length > 0) {
      return new Set(weekend.map((day) => day % 7));
    }
  } catch {
    // fall back to Saturday/Sunday
  }
  return DEFAULT_WEEKEND_DAYS;
};

const getMonthDays = (
  year: number,
  month: number,
  firstDow: number,
  weekendDays: ReadonlySet<number>,
): CalendarDay[] => {
  const today = toISODate(new Date());
  const days: CalendarDay[] = [];
  const first = new Date(Date.UTC(year, month, 1));
  const rawDow = first.getUTCDay();
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
      isWeekend: weekendDays.has(d.getUTCDay()),
    });
  }
  return days;
};

const getWeekdayLabels = (
  locale: string,
  firstDow: number,
  weekendDays: ReadonlySet<number>,
): CalendarWeekday[] => {
  const fmt = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    timeZone: "UTC",
  });
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.UTC(2024, 0, 1 + ((i + firstDow) % 7)));
    return {
      isWeekend: weekendDays.has(d.getUTCDay()),
      label: fmt.format(d),
    };
  });
};

const getMonthLabels = (
  locale: string,
  format: "long" | "short" = "long",
): string[] => {
  const fmt = new Intl.DateTimeFormat(locale, {
    month: format,
    timeZone: "UTC",
  });
  return Array.from({ length: 12 }, (_, i) =>
    fmt.format(new Date(Date.UTC(2024, i, 1))),
  );
};

const formatMonthYear = (locale: string, year: number, month: number): string =>
  new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month, 1)));

/** Derive a locale-correct "Today" label (e.g., "Dnes", "Heute", "Today"). */
const deriveTodayLabel = (locale: string): string => {
  const raw = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
    0,
    "day",
  );
  return raw.charAt(0).toUpperCase() + raw.slice(1);
};

const normalizeDate = (v: string | Date | null | undefined): string => {
  if (v === null || v === undefined) {
    return "";
  }
  if (v instanceof Date) {
    return v.toISOString().slice(0, 10);
  }
  return v.length >= 10 ? v.slice(0, 10) : v;
};

const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return toISODate(d);
};

const isBefore = (a: string, b: string): boolean => a < b;
const isAfter = (a: string, b: string): boolean => a > b;

/** Round down to the start of a decade (e.g. 2026 → 2020). */
const decadeStart = (year: number): number => Math.floor(year / 10) * 10;

const DECADE_SIZE = 12; // 10 years + 1 before + 1 after for context

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

type PickerView = "days" | "months" | "years";

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type DatePickerPopoverProps = {
  value: string | Date | null;
  onChange: (value: string | null) => void;
  locale?: string;
  isOverdue?: boolean;
  showIcon?: boolean;
  clearLabel?: string;
  /** Label for the "go to today" button. Auto-localized from the locale when omitted. */
  todayLabel?: string;
  overdueLabel?: string;
  minDate?: string;
  maxDate?: string;
  isDateDisabled?: (date: string) => boolean;
};

function DatePickerPopover({
  value: rawValue,
  onChange,
  locale: localeProp,
  isOverdue = false,
  showIcon = true,
  clearLabel = "Clear date",
  todayLabel: todayLabelProp,
  overdueLabel,
  minDate,
  maxDate,
  isDateDisabled,
}: DatePickerPopoverProps) {
  const locale = localeProp ?? navigator.language;
  const value = normalizeDate(rawValue);
  const todayLabel = todayLabelProp ?? deriveTodayLabel(locale);
  const firstDow = useMemo(() => getFirstDayOfWeek(locale), [locale]);
  const weekendDays = useMemo(() => getWeekendDays(locale), [locale]);

  const [viewYear, setViewYear] = useState(() => {
    const d = value ? new Date(`${value}T00:00:00Z`) : new Date();
    return d.getUTCFullYear();
  });
  const [viewMonth, setViewMonth] = useState(() => {
    const d = value ? new Date(`${value}T00:00:00Z`) : new Date();
    return d.getUTCMonth();
  });
  const [view, setView] = useState<PickerView>("days");
  const [decadeBase, setDecadeBase] = useState(() => decadeStart(viewYear));

  const days = useMemo(
    () => getMonthDays(viewYear, viewMonth, firstDow, weekendDays),
    [viewYear, viewMonth, firstDow, weekendDays],
  );
  const weekdays = useMemo(
    () => getWeekdayLabels(locale, firstDow, weekendDays),
    [locale, firstDow, weekendDays],
  );

  const [focusedDate, setFocusedDate] = useState("");
  const gridRef = useRef<HTMLDivElement>(null);

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
        const dow = (new Date(`${current}T00:00:00Z`).getUTCDay() + 6) % 7;
        const offset = (dow - firstDow + 7) % 7;
        next = addDays(current, -offset);
      } else if (e.key === "End") {
        const dow = (new Date(`${current}T00:00:00Z`).getUTCDay() + 6) % 7;
        const offset = (dow - firstDow + 7) % 7;
        next = addDays(current, 6 - offset);
      } else if (e.key === "PageUp") {
        const d = new Date(`${current}T00:00:00Z`);
        if (e.shiftKey) {
          d.setUTCFullYear(d.getUTCFullYear() - 1);
        } else {
          d.setUTCMonth(d.getUTCMonth() - 1);
        }
        next = toISODate(d);
      } else if (e.key === "PageDown") {
        const d = new Date(`${current}T00:00:00Z`);
        if (e.shiftKey) {
          d.setUTCFullYear(d.getUTCFullYear() + 1);
        } else {
          d.setUTCMonth(d.getUTCMonth() + 1);
        }
        next = toISODate(d);
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
        const nextDate = new Date(`${next}T00:00:00Z`);
        const nextMonth = nextDate.getUTCMonth();
        const nextYear = nextDate.getUTCFullYear();
        if (nextMonth !== viewMonth || nextYear !== viewYear) {
          setViewMonth(nextMonth);
          setViewYear(nextYear);
        }
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

  // -- Navigation handlers per view --

  const handlePrev = () => {
    if (view === "days") {
      if (viewMonth === 0) {
        setViewYear((y) => y - 1);
        setViewMonth(11);
      } else {
        setViewMonth((m) => m - 1);
      }
    } else if (view === "months") {
      setViewYear((y) => y - 1);
    } else {
      setDecadeBase((d) => d - 10);
    }
  };

  const handleNext = () => {
    if (view === "days") {
      if (viewMonth === 11) {
        setViewYear((y) => y + 1);
        setViewMonth(0);
      } else {
        setViewMonth((m) => m + 1);
      }
    } else if (view === "months") {
      setViewYear((y) => y + 1);
    } else {
      setDecadeBase((d) => d + 10);
    }
  };

  // Header label per view
  const headerLabel = (() => {
    if (view === "days") {
      return formatMonthYear(locale, viewYear, viewMonth);
    }
    if (view === "months") {
      return String(viewYear);
    }
    return `${decadeBase}\u2013${decadeBase + 9}`;
  })();

  const handleHeaderClick = () => {
    if (view === "days") {
      setView("months");
    } else if (view === "months") {
      setDecadeBase(decadeStart(viewYear));
      setView("years");
    }
    // In years view, clicking header does nothing (top level)
  };

  const handleMonthSelect = (month: number) => {
    setViewMonth(month);
    setView("days");
  };

  const handleYearSelect = (year: number) => {
    setViewYear(year);
    setDecadeBase(decadeStart(year));
    setView("months");
  };

  // Current selection context for the sub-grids (null when no date selected)
  const selectedYear = value
    ? new Date(`${value}T00:00:00Z`).getUTCFullYear()
    : null;
  const selectedMonth = value
    ? new Date(`${value}T00:00:00Z`).getUTCMonth()
    : null;

  // Reset view state when the popover closes so reopening always shows the day grid
  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setView("days");
      setDecadeBase(decadeStart(viewYear));
    }
  };

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <button
            aria-label={value ? displayLabel : undefined}
            className={cn(
              "flex h-auto min-h-7 w-full min-w-0 items-center gap-1.5",
              "rounded-md px-1.5 text-sm",
              "hover:bg-muted transition-colors",
              (() => {
                if (isOverdue) {
                  return "text-destructive";
                }
                if (value) {
                  return "text-foreground";
                }
                return "text-muted-foreground";
              })(),
            )}
            type="button"
          />
        }
      >
        {showIcon && <CalendarIcon className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 overflow-hidden text-start wrap-break-word text-ellipsis">
          {displayLabel}
        </span>
        {isOverdue && overdueLabel && (
          <span className="text-destructive text-xs">{overdueLabel}</span>
        )}
      </PopoverTrigger>
      <PopoverPopup
        className="*:data-[slot=popover-viewport]:p-2!"
        side="bottom"
        sideOffset={4}
      >
        <div className="w-60" role="dialog" aria-label="Date picker">
          {/* Shared header: [<] label [>] */}
          <div className="flex items-center justify-between gap-1 pb-1">
            <Button
              aria-label={(() => {
                if (view === "days") {
                  return "Previous month";
                }
                if (view === "months") {
                  return "Previous year";
                }
                return "Previous decade";
              })()}
              onClick={handlePrev}
              size="icon-xs"
              variant="ghost"
            >
              <ChevronLeftIcon />
            </Button>
            <button
              className={cn(
                "text-xs font-medium transition-colors",
                view !== "years" &&
                  "hover:bg-muted cursor-pointer rounded-md px-2 py-0.5",
                view === "years" && "cursor-default",
              )}
              onClick={handleHeaderClick}
              tabIndex={view === "years" ? -1 : 0}
              type="button"
            >
              {headerLabel}
            </button>
            <Button
              aria-label={(() => {
                if (view === "days") {
                  return "Next month";
                }
                if (view === "months") {
                  return "Next year";
                }
                return "Next decade";
              })()}
              onClick={handleNext}
              size="icon-xs"
              variant="ghost"
            >
              <ChevronRightIcon />
            </Button>
          </div>

          {/* View: days */}
          {view === "days" && (
            <>
              <div
                className="grid grid-cols-7 gap-0"
                role="row"
                aria-hidden="true"
              >
                {weekdays.map((weekday) => (
                  <span
                    className={cn(
                      "py-1 text-center text-[10px]",
                      weekday.isWeekend
                        ? "text-muted-foreground"
                        : "text-foreground-label",
                    )}
                    key={weekday.label}
                  >
                    {weekday.label}
                  </span>
                ))}
              </div>

              <div
                aria-label={headerLabel}
                className="grid grid-cols-7 gap-0"
                onKeyDown={handleGridKeyDown}
                ref={gridRef}
                role="grid"
                tabIndex={-1}
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
                          ? "text-foreground-disabled cursor-not-allowed"
                          : "hover:bg-muted cursor-pointer",
                        !day.isCurrentMonth &&
                          !disabled &&
                          "text-foreground-disabled",
                        day.isWeekend &&
                          day.isCurrentMonth &&
                          !disabled &&
                          !isSelected &&
                          "text-foreground-label",
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
            </>
          )}

          {/* View: months */}
          {view === "months" && (
            <MonthGrid
              currentMonth={selectedMonth}
              currentYear={selectedYear}
              locale={locale}
              onSelect={handleMonthSelect}
              viewYear={viewYear}
            />
          )}

          {/* View: years */}
          {view === "years" && (
            <YearGrid
              currentYear={selectedYear}
              decadeBase={decadeBase}
              onSelect={handleYearSelect}
            />
          )}

          {/* Bottom row: today + clear */}
          <div className="mt-1 flex items-center gap-1 border-t pt-1">
            <Button
              className="flex-1"
              onClick={() => {
                const today = new Date();
                setViewYear(today.getUTCFullYear());
                setViewMonth(today.getUTCMonth());
                setView("days");
              }}
              size="xs"
              variant="ghost"
            >
              {todayLabel}
            </Button>
            {value && (
              <Button
                className="flex-1"
                onClick={() => onChange(null)}
                size="xs"
                variant="ghost"
              >
                {clearLabel}
              </Button>
            )}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export { DatePickerPopover };
export type { DatePickerPopoverProps };

// ---------------------------------------------------------------------------
// Helper sub-view components (placed after the exported component per convention)
// ---------------------------------------------------------------------------

// -- Month picker grid (4×3) --

const MONTHS_PER_ROW = 3;

const MonthGrid = ({
  locale,
  viewYear,
  currentMonth,
  currentYear,
  onSelect,
}: {
  locale: string;
  viewYear: number;
  currentMonth: number | null;
  currentYear: number | null;
  onSelect: (month: number) => void;
}) => {
  const labels = useMemo(() => getMonthLabels(locale, "short"), [locale]);
  const now = new Date();
  const todayMonth = now.getUTCMonth();
  const todayYear = now.getUTCFullYear();

  // Group months into rows of 3 for proper role="row" semantics
  const rows: number[][] = [];
  for (let r = 0; r < 12; r += MONTHS_PER_ROW) {
    rows.push(Array.from({ length: MONTHS_PER_ROW }, (_, c) => r + c));
  }

  return (
    <div className="grid grid-cols-3 gap-1 py-1" role="grid">
      {rows.map((row) => (
        <div className="contents" key={row[0]} role="row">
          {row.map((i) => {
            const isSelected =
              currentMonth !== null &&
              currentYear !== null &&
              i === currentMonth &&
              viewYear === currentYear;
            const isNow = i === todayMonth && viewYear === todayYear;
            return (
              <button
                aria-selected={isSelected || undefined}
                className={cn(
                  "rounded-md px-2 py-1.5 text-xs transition-colors",
                  "hover:bg-muted cursor-pointer",
                  "focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none",
                  isNow && !isSelected && "ring-foreground font-medium ring-1",
                  isSelected &&
                    "bg-primary text-primary-foreground hover:bg-primary/90",
                )}
                key={i}
                onClick={() => onSelect(i)}
                role="gridcell"
                type="button"
              >
                {!/^\d/u.test(labels[i] ?? "") && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "me-1 text-[10px] tabular-nums opacity-50",
                      !isSelected && "text-muted-foreground",
                    )}
                  >
                    {i + 1}
                  </span>
                )}
                {labels[i]}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
};

// -- Year picker grid (4×3, decade with context) --

const YEARS_PER_ROW = 3;

const YearGrid = ({
  decadeBase,
  currentYear,
  onSelect,
}: {
  decadeBase: number;
  currentYear: number | null;
  onSelect: (year: number) => void;
}) => {
  const todayYear = new Date().getUTCFullYear();
  // Show decade - 1 through decade + 10 (12 items)
  const startYear = decadeBase - 1;

  const rows: number[][] = [];
  for (let r = 0; r < DECADE_SIZE; r += YEARS_PER_ROW) {
    rows.push(
      Array.from(
        { length: Math.min(YEARS_PER_ROW, DECADE_SIZE - r) },
        (_, c) => r + c,
      ),
    );
  }

  return (
    <div className="grid grid-cols-3 gap-1 py-1" role="grid">
      {rows.map((row) => (
        <div className="contents" key={row[0]} role="row">
          {row.map((i) => {
            const year = startYear + i;
            const isOutside = i === 0 || i === DECADE_SIZE - 1;
            const isSelected = currentYear !== null && year === currentYear;
            const isNow = year === todayYear;
            return (
              <button
                aria-selected={isSelected || undefined}
                className={cn(
                  "rounded-md px-2 py-1.5 text-xs transition-colors",
                  "hover:bg-muted cursor-pointer",
                  "focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none",
                  isOutside && !isSelected && "text-foreground-subtle",
                  isNow && !isSelected && "ring-foreground font-medium ring-1",
                  isSelected &&
                    "bg-primary text-primary-foreground hover:bg-primary/90",
                )}
                key={year}
                onClick={() => onSelect(year)}
                role="gridcell"
                type="button"
              >
                {year}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
};
