"use client";

import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { panic } from "better-result";
import { Temporal } from "temporal-polyfill/full";

import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "../icons";
import { FIELD_TRIGGER_CLASS_NAME } from "../lib/field-trigger";
import type { OverlayLayer } from "../lib/overlay-layer";
import { cn } from "../lib/utils";
import { getLocaleWeekInfo, getWeekendDays } from "../lib/week";
import { Button } from "./button";
import {
  DATE_PICKER_MODE,
  DEFAULT_PICKER_TIME,
  type DatePickerMode,
  formatDateTimeValue,
  getHourOptions,
  getMinuteOptions,
  getTimeFieldNames,
  joinPickerTime,
  localDateFromTimestamp,
  millisecondsUntilNextLocalDate,
  parseDateTimeValue,
  resolveCalendarViewMonth,
  shiftCalendarDate,
  splitPickerTime,
  type CalendarMonth,
  type PickerClock,
  type PickerTimeOption,
} from "./date-picker-popover.logic";
import { DirectionalIcon } from "./directional-icon";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./select";

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

const toISODate = (date: Temporal.PlainDate): string => date.toString();
const toUTCDateTime = (date: Temporal.PlainDate): number =>
  date.toZonedDateTime({
    plainTime: Temporal.PlainTime.from("00:00"),
    timeZone: "UTC",
  }).epochMilliseconds;
const HYDRATION_DATE = "1970-01-01";
const HYDRATION_LOCALE = "en";
const noopSubscribe = (_onStoreChange: () => void) => () => undefined;

const getLocalToday = (): string =>
  localDateFromTimestamp(Temporal.Now.instant().epochMilliseconds);

const localDateListeners = new Set<() => void>();
let localDateTimeoutId: ReturnType<typeof setTimeout> | undefined;

const notifyLocalDateListeners = () => {
  for (const listener of localDateListeners) {
    listener();
  }
};

const scheduleNextLocalDate = () => {
  if (localDateTimeoutId !== undefined) {
    clearTimeout(localDateTimeoutId);
  }
  localDateTimeoutId = setTimeout(() => {
    notifyLocalDateListeners();
    if (localDateListeners.size > 0) {
      scheduleNextLocalDate();
    }
  }, millisecondsUntilNextLocalDate(Temporal.Now.instant().epochMilliseconds));
};

const refreshLocalDateEnvironment = () => {
  notifyLocalDateListeners();
  if (localDateListeners.size > 0) {
    scheduleNextLocalDate();
  }
};

const startLocalDateSubscription = () => {
  scheduleNextLocalDate();
  globalThis.addEventListener("focus", refreshLocalDateEnvironment);
};

const stopLocalDateSubscription = () => {
  globalThis.removeEventListener("focus", refreshLocalDateEnvironment);
  if (localDateTimeoutId !== undefined) {
    clearTimeout(localDateTimeoutId);
    localDateTimeoutId = undefined;
  }
};

const subscribeToLocalDate = (onStoreChange: () => void) => {
  localDateListeners.add(onStoreChange);
  if (localDateListeners.size === 1) {
    startLocalDateSubscription();
  }
  return () => {
    localDateListeners.delete(onStoreChange);
    if (localDateListeners.size === 0) {
      stopLocalDateSubscription();
    }
  };
};

const useHydrationSafeToday = (): string =>
  useSyncExternalStore(
    subscribeToLocalDate,
    getLocalToday,
    () => HYDRATION_DATE,
  );

const useHydrationSafeBrowserLocale = (): string =>
  useSyncExternalStore(
    noopSubscribe,
    () => navigator.language || HYDRATION_LOCALE,
    () => HYDRATION_LOCALE,
  );

const getFirstDayOfWeek = (locale: string): number => {
  const info = getLocaleWeekInfo(locale);
  if (!info) {
    return 0;
  }
  // Convert Intl's 1=Mon … 7=Sun firstDay to the picker's 0=Mon … 6=Sun index.
  return info.firstDay === 7 ? 6 : info.firstDay - 1;
};

const getMonthDays = (
  year: number,
  month: number,
  firstDow: number,
  weekendDays: ReadonlySet<number>,
  today: string,
): CalendarDay[] => {
  const days: CalendarDay[] = [];
  const first = Temporal.PlainDate.from({ year, month: month + 1, day: 1 });
  const startOffset = (first.dayOfWeek - 1 - firstDow + 7) % 7;
  const start = first.subtract({ days: startOffset });

  for (let i = 0; i < 42; i++) {
    const d = start.add({ days: i });
    const iso = toISODate(d);
    days.push({
      date: iso,
      isCurrentMonth: d.month === month + 1,
      isToday: iso === today,
      isWeekend: weekendDays.has(d.dayOfWeek % 7),
    });
  }
  return days;
};

const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

const getWeekdayFormatter = (locale: string): Intl.DateTimeFormat => {
  const fmt =
    weekdayFormatters.get(locale) ??
    new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  weekdayFormatters.set(locale, fmt);
  return fmt;
};

const getWeekdayLabels = (
  locale: string,
  firstDow: number,
  weekendDays: ReadonlySet<number>,
): CalendarWeekday[] => {
  const fmt = getWeekdayFormatter(locale);
  return Array.from({ length: 7 }, (_, i) => {
    const d = Temporal.PlainDate.from("2024-01-01").add({
      days: (i + firstDow) % 7,
    });
    return {
      isWeekend: weekendDays.has(d.dayOfWeek % 7),
      label: fmt.format(toUTCDateTime(d)),
    };
  });
};

const monthFormatters = new Map<string, Intl.DateTimeFormat>();

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

const getDateFormatter = (
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat => {
  const key = `${locale}:${JSON.stringify(options)}`;
  const formatter =
    dateFormatters.get(key) ?? new Intl.DateTimeFormat(locale, options);
  dateFormatters.set(key, formatter);
  return formatter;
};

const getMonthFormatter = (
  locale: string,
  format: "long" | "short",
): Intl.DateTimeFormat => {
  const key = `${locale}:${format}`;
  const fmt =
    monthFormatters.get(key) ??
    new Intl.DateTimeFormat(locale, {
      month: format,
      // The picker grid is Gregorian; pin labels so a Hijri locale preference
      // does not mislabel Gregorian months (numerals still follow the locale).
      calendar: "gregory",
      timeZone: "UTC",
    });
  monthFormatters.set(key, fmt);
  return fmt;
};

const getMonthLabels = (
  locale: string,
  format: "long" | "short" = "long",
): string[] => {
  const fmt = getMonthFormatter(locale, format);
  return Array.from({ length: 12 }, (_, i) =>
    fmt.format(
      toUTCDateTime(
        Temporal.PlainDate.from({ year: 2024, month: i + 1, day: 1 }),
      ),
    ),
  );
};

const monthYearFormatters = new Map<string, Intl.DateTimeFormat>();

const getMonthYearFormatter = (locale: string): Intl.DateTimeFormat => {
  const fmt =
    monthYearFormatters.get(locale) ??
    new Intl.DateTimeFormat(locale, {
      month: "long",
      year: "numeric",
      calendar: "gregory",
      timeZone: "UTC",
    });
  monthYearFormatters.set(locale, fmt);
  return fmt;
};

const formatMonthYear = (locale: string, year: number, month: number): string =>
  getMonthYearFormatter(locale).format(
    toUTCDateTime(Temporal.PlainDate.from({ year, month: month + 1, day: 1 })),
  );

const relativeTimeFormatters = new Map<string, Intl.RelativeTimeFormat>();

const getRelativeTimeFormatter = (locale: string): Intl.RelativeTimeFormat => {
  const fmt =
    relativeTimeFormatters.get(locale) ??
    new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  relativeTimeFormatters.set(locale, fmt);
  return fmt;
};

/** Derive a locale-correct "Today" label (e.g., "Dnes", "Heute", "Today"). */
const deriveTodayLabel = (locale: string): string => {
  const raw = getRelativeTimeFormatter(locale).format(0, "day");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
};

const utcDateTimeFromDate = (date: Date): string =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime())
    .toZonedDateTimeISO("UTC")
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" });

const normalizeDate = (v: string | Date | null | undefined): string => {
  if (v === null || v === undefined) {
    return "";
  }
  if (v instanceof Date) {
    return Temporal.Instant.fromEpochMilliseconds(v.getTime())
      .toZonedDateTimeISO("UTC")
      .toPlainDate()
      .toString();
  }
  return v.length >= 10 ? v.slice(0, 10) : v;
};

const addDays = (iso: string, n: number): string =>
  Temporal.PlainDate.from(iso).add({ days: n }).toString();

const isBefore = (a: string, b: string): boolean => a < b;
const isAfter = (a: string, b: string): boolean => a > b;

/** Round down to the start of a decade (e.g. 2026 → 2020). */
const decadeStart = (year: number): number => Math.floor(year / 10) * 10;

const DECADE_SIZE = 12; // 10 years + 1 before + 1 after for context

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

type PickerView = "days" | "months" | "years";

const DISPLAY_DATE_FORMAT = {
  month: "short",
  day: "numeric",
  year: "numeric",
  calendar: "gregory",
  timeZone: "UTC",
} as const satisfies Intl.DateTimeFormatOptions;

const DISPLAY_DATE_TIME_FORMAT = {
  ...DISPLAY_DATE_FORMAT,
  hour: "numeric",
  minute: "2-digit",
} as const satisfies Intl.DateTimeFormatOptions;

/** What the picker holds, per mode. `date` is `""` while nothing is set. */
type PickerSelection =
  | { mode: typeof DATE_PICKER_MODE.date; date: string }
  | {
      mode: typeof DATE_PICKER_MODE.dateTime;
      date: string;
      time: string | null;
    };

const resolveSelection = (
  mode: DatePickerMode,
  value: string | Date | null,
): PickerSelection => {
  switch (mode) {
    case DATE_PICKER_MODE.date: {
      return { mode, date: normalizeDate(value) };
    }
    case DATE_PICKER_MODE.dateTime: {
      const parsed = parseDateTimeValue(
        value instanceof Date ? utcDateTimeFromDate(value) : value,
      );
      return {
        mode: DATE_PICKER_MODE.dateTime,
        date: parsed?.date ?? "",
        time: parsed?.time ?? null,
      };
    }
    default: {
      mode satisfies never;
      return panic(`Unhandled date picker mode: ${String(mode)}`);
    }
  }
};

/** Locale-formatted trigger text, or null while nothing is set. */
const formatSelection = (
  locale: string,
  selection: PickerSelection,
): string | null => {
  if (selection.date === "") {
    return null;
  }
  const date = Temporal.PlainDate.from(selection.date);
  switch (selection.mode) {
    case DATE_PICKER_MODE.date: {
      return getDateFormatter(locale, DISPLAY_DATE_FORMAT).format(
        toUTCDateTime(date),
      );
    }
    case DATE_PICKER_MODE.dateTime: {
      const instant = date.toZonedDateTime({
        plainTime: Temporal.PlainTime.from(
          selection.time ?? DEFAULT_PICKER_TIME,
        ),
        timeZone: "UTC",
      }).epochMilliseconds;
      return getDateFormatter(locale, DISPLAY_DATE_TIME_FORMAT).format(instant);
    }
    default: {
      selection satisfies never;
      return panic(`Unhandled date picker mode: ${String(selection)}`);
    }
  }
};

const TRIGGER_VARIANT_CLASS_NAMES = {
  inline: cn(
    "flex h-auto min-h-7 w-full min-w-0 items-center gap-1.5",
    "rounded-md px-1.5 text-sm",
    "hover:bg-muted",
    "data-disabled:pointer-events-none data-disabled:opacity-64",
  ),
  field: cn(FIELD_TRIGGER_CLASS_NAME, "min-w-0 justify-start gap-1.5"),
} as const satisfies Record<DatePickerPopoverVariant, string>;

type NavigationLabels = { next: string; previous: string };

type PopupLabels = {
  dialog: string;
  navigation: Record<PickerView, NavigationLabels>;
  time: string;
};

/** The package carries no catalogs: English defaults the host replaces. */
const resolvePopupLabels = (props: DatePickerPopoverProps): PopupLabels => ({
  dialog: props.dialogLabel ?? "Date picker",
  navigation: {
    days: {
      next: props.nextMonthLabel ?? "Next month",
      previous: props.previousMonthLabel ?? "Previous month",
    },
    months: {
      next: props.nextYearLabel ?? "Next year",
      previous: props.previousYearLabel ?? "Previous year",
    },
    years: {
      next: props.nextDecadeLabel ?? "Next decade",
      previous: props.previousDecadeLabel ?? "Previous decade",
    },
  },
  time: props.timeLabel ?? "Time",
});

type PickerSizeClassNames = {
  popup: string;
  heading: string;
  day: string;
  /** Month and year cells. */
  cell: string;
};

const PICKER_SIZE_CLASS_NAMES = {
  compact: { popup: "w-60", heading: "", day: "", cell: "" },
  touch: {
    // Seven 44px day columns.
    popup: "w-60 pointer-coarse:w-77",
    heading: "pointer-coarse:min-h-11 pointer-coarse:text-sm",
    day: "pointer-coarse:size-11 pointer-coarse:text-sm",
    cell: "pointer-coarse:min-h-11 pointer-coarse:text-sm",
  },
} as const satisfies Record<DatePickerPopoverSize, PickerSizeClassNames>;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * `compact` keeps the dense 32px day cells everywhere. `touch` grows day,
 * month, and year cells to 44px targets under a coarse pointer and leaves a
 * fine pointer on the compact metric.
 */
type DatePickerPopoverSize = "compact" | "touch";

/**
 * `inline` is the borderless trigger for property rows and table cells;
 * `field` is the bordered box form controls share with `SelectTrigger`.
 */
type DatePickerPopoverVariant = "inline" | "field";

type DatePickerPopoverProps = {
  /**
   * `date` (default) reads and writes `YYYY-MM-DD`. `date-time` reads and
   * writes `YYYY-MM-DDTHH:mm`, a zone-less wall-clock time the host converts
   * to and from an instant in the time zone it owns. A `Date` is read in UTC
   * in both modes, so a string is the way to keep a local wall-clock time.
   */
  mode?: DatePickerMode;
  value: string | Date | null;
  onChange: (value: string | null) => void;
  id?: string;
  /** ID of the visible field label, when the picker is part of a form field. */
  labelledBy?: string;
  /** Merged into the trigger's classes. */
  className?: string;
  disabled?: boolean;
  /** Hide the clear button, for fields that must keep a value. */
  hideClear?: boolean;
  size?: DatePickerPopoverSize;
  variant?: DatePickerPopoverVariant;
  locale?: string;
  isOverdue?: boolean;
  showIcon?: boolean;
  /** Shown in the trigger when no date is set. Falls back to an em dash so
   *  the control still has height; pass a call-to-action ("Select date…") to
   *  make the empty state self-explanatory. */
  placeholderLabel?: string;
  clearLabel?: string;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Label for the "go to today" button. Auto-localized from the locale when omitted. */
  todayLabel?: string;
  overdueLabel?: string;
  /** Accessible name of the popup. The package carries no catalogs, so the
   *  English defaults below are meant to be replaced by the host. */
  dialogLabel?: string;
  previousMonthLabel?: string;
  nextMonthLabel?: string;
  previousYearLabel?: string;
  nextYearLabel?: string;
  previousDecadeLabel?: string;
  nextDecadeLabel?: string;
  /** Label of the time input in `date-time` mode. */
  timeLabel?: string;
  /** Inclusive `YYYY-MM-DD` bounds; in `date-time` mode they bound the day. */
  minDate?: string;
  maxDate?: string;
  isDateDisabled?: (date: string) => boolean;
  layer?: OverlayLayer;
};

type DatePickerPopoverContentProps = DatePickerPopoverProps & {
  locale: string;
  today: string;
};

const DatePickerPopoverContent = (props: DatePickerPopoverContentProps) => {
  const {
    id,
    labelledBy,
    className,
    disabled,
    hideClear,
    size = "compact",
    variant = "inline",
    mode = DATE_PICKER_MODE.date,
    value: rawValue,
    onChange,
    locale,
    isOverdue = false,
    showIcon = true,
    placeholderLabel,
    clearLabel = "Clear date",
    defaultOpen = false,
    onOpenChange,
    todayLabel: todayLabelProp,
    overdueLabel,
    minDate,
    maxDate,
    isDateDisabled,
    layer = "default",
    today,
  } = props;
  const selection = resolveSelection(mode, rawValue);
  const value = selection.date;
  const labels = resolvePopupLabels(props);
  const sizeClassNames = PICKER_SIZE_CLASS_NAMES[size];
  const displayValueId = useId();
  const todayLabel = todayLabelProp ?? deriveTodayLabel(locale);
  const firstDow = useMemo(() => getFirstDayOfWeek(locale), [locale]);
  const weekendDays = useMemo(() => getWeekendDays(locale), [locale]);

  const [viewMonthOverride, setViewMonthOverride] =
    useState<CalendarMonth | null>(null);
  const { month: viewMonth, year: viewYear } = resolveCalendarViewMonth({
    override: viewMonthOverride,
    today,
    value,
  });
  const [view, setView] = useState<PickerView>("days");
  const [decadeBaseOverride, setDecadeBaseOverride] = useState<number | null>(
    null,
  );
  const decadeBase = decadeBaseOverride ?? decadeStart(viewYear);

  const days = useMemo(
    () => getMonthDays(viewYear, viewMonth, firstDow, weekendDays, today),
    [viewYear, viewMonth, firstDow, weekendDays, today],
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

  const displayLabel =
    formatSelection(locale, selection) ?? placeholderLabel ?? "\u2014";

  const selectDay = (date: string) => {
    switch (selection.mode) {
      case DATE_PICKER_MODE.date: {
        onChange(date);
        return;
      }
      case DATE_PICKER_MODE.dateTime: {
        onChange(
          formatDateTimeValue({
            date,
            time: selection.time ?? DEFAULT_PICKER_TIME,
          }),
        );
        return;
      }
      default: {
        selection satisfies never;
        panic(`Unhandled date picker mode: ${String(selection)}`);
      }
    }
  };

  const handleTimeChange = (clock: PickerClock) => {
    if (value === "") {
      return;
    }
    onChange(formatDateTimeValue({ date: value, time: joinPickerTime(clock) }));
  };

  const formatDayLabel = useCallback(
    (iso: string): string =>
      getDateFormatter(locale, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        calendar: "gregory",
        timeZone: "UTC",
      }).format(toUTCDateTime(Temporal.PlainDate.from(iso))),
    [locale],
  );

  // Keyboard handler for the day grid
  const handleGridKeyDown = (e: React.KeyboardEvent) => {
    const firstDay = days.at(0);
    if (!firstDay) {
      return;
    }
    const current = focusedDate || value || firstDay.date;
    let next: string | null = null;

    // The day grid lays out inline (right-to-left under RTL), so the
    // horizontal arrows must follow visual direction: ArrowLeft advances
    // a day when the grid flows right-to-left. Read the rendered grid's
    // computed direction so this stays correct regardless of how the host
    // app or an enclosing subtree sets `dir`. Up/Down are block-axis and
    // never mirror.
    const isRtl =
      gridRef.current !== null &&
      getComputedStyle(gridRef.current).direction === "rtl";
    const horizontalStep = isRtl ? -1 : 1;

    if (e.key === "ArrowRight") {
      next = addDays(current, horizontalStep);
    } else if (e.key === "ArrowLeft") {
      next = addDays(current, -horizontalStep);
    } else if (e.key === "ArrowDown") {
      next = addDays(current, 7);
    } else if (e.key === "ArrowUp") {
      next = addDays(current, -7);
    } else if (e.key === "Home") {
      const dow = Temporal.PlainDate.from(current).dayOfWeek - 1;
      const offset = (dow - firstDow + 7) % 7;
      next = addDays(current, -offset);
    } else if (e.key === "End") {
      const dow = Temporal.PlainDate.from(current).dayOfWeek - 1;
      const offset = (dow - firstDow + 7) % 7;
      next = addDays(current, 6 - offset);
    } else if (e.key === "PageUp") {
      next = shiftCalendarDate(
        current,
        e.shiftKey ? { years: -1 } : { months: -1 },
      );
    } else if (e.key === "PageDown") {
      next = shiftCalendarDate(
        current,
        e.shiftKey ? { years: 1 } : { months: 1 },
      );
    } else {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (!isDayDisabled(current)) {
          selectDay(current);
        }
      }
      return;
    }

    e.preventDefault();
    if (next) {
      setFocusedDate(next);
      const nextDate = Temporal.PlainDate.from(next);
      const nextMonth = nextDate.month - 1;
      const nextYear = nextDate.year;
      if (nextMonth !== viewMonth || nextYear !== viewYear) {
        setViewMonthOverride({ month: nextMonth, year: nextYear });
      }
      requestAnimationFrame(() => {
        const btn = gridRef.current?.querySelector<HTMLButtonElement>(
          `[data-date="${next}"]`,
        );
        btn?.focus();
      });
    }
  };

  // -- Navigation handlers per view --

  const handlePrev = () => {
    if (view === "days") {
      if (viewMonth === 0) {
        setViewMonthOverride({ month: 11, year: viewYear - 1 });
      } else {
        setViewMonthOverride({ month: viewMonth - 1, year: viewYear });
      }
    } else if (view === "months") {
      setViewMonthOverride({ month: viewMonth, year: viewYear - 1 });
    } else {
      setDecadeBaseOverride(decadeBase - 10);
    }
  };

  const handleNext = () => {
    if (view === "days") {
      if (viewMonth === 11) {
        setViewMonthOverride({ month: 0, year: viewYear + 1 });
      } else {
        setViewMonthOverride({ month: viewMonth + 1, year: viewYear });
      }
    } else if (view === "months") {
      setViewMonthOverride({ month: viewMonth, year: viewYear + 1 });
    } else {
      setDecadeBaseOverride(decadeBase + 10);
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
      setDecadeBaseOverride(decadeStart(viewYear));
      setView("years");
    }
    // In years view, clicking header does nothing (top level)
  };

  const handleMonthSelect = (month: number) => {
    setViewMonthOverride({ month, year: viewYear });
    setView("days");
  };

  const handleYearSelect = (year: number) => {
    setViewMonthOverride({ month: viewMonth, year });
    setDecadeBaseOverride(decadeStart(year));
    setView("months");
  };

  // Current selection context for the sub-grids (null when no date selected)
  const selectedYear = value ? Temporal.PlainDate.from(value).year : null;
  const selectedMonth = value ? Temporal.PlainDate.from(value).month - 1 : null;

  // Reset view state when the popover closes so reopening always shows the day grid
  const handleOpenChange = (open: boolean) => {
    onOpenChange?.(open);
    if (open) {
      setViewMonthOverride(null);
      setFocusedDate(value || today);
    }
    if (!open) {
      setView("days");
      setDecadeBaseOverride(decadeStart(viewYear));
    }
  };

  const triggerToneClassName = (() => {
    if (isOverdue) {
      return "text-destructive";
    }
    if (value) {
      return "text-foreground";
    }
    return "text-muted-foreground";
  })();

  return (
    <Popover defaultOpen={defaultOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        disabled={disabled}
        render={
          <button
            aria-label={!labelledBy && value ? displayLabel : undefined}
            aria-labelledby={
              labelledBy ? `${labelledBy} ${displayValueId}` : undefined
            }
            className={cn(
              TRIGGER_VARIANT_CLASS_NAMES[variant],
              triggerToneClassName,
              className,
            )}
            id={id}
            type="button"
          />
        }
      >
        {showIcon && <CalendarIcon className="size-3.5 shrink-0" />}
        <span
          className="min-w-0 flex-1 truncate text-start"
          id={labelledBy ? displayValueId : undefined}
        >
          {displayLabel}
        </span>
        {isOverdue && overdueLabel && (
          <span className="text-destructive text-xs">{overdueLabel}</span>
        )}
      </PopoverTrigger>
      <PopoverPopup
        initialFocus={() =>
          gridRef.current?.querySelector<HTMLButtonElement>(
            `[data-date="${value || today}"]`,
          ) ?? gridRef.current
        }
        // The entry scale would shrink the day cells below their touch and
        // compact sizes while the popup opens.
        className="data-starting-style:scale-100"
        layer={layer}
        padding="sm"
        side="bottom"
        sideOffset={4}
      >
        <div
          aria-label={labels.dialog}
          className={sizeClassNames.popup}
          data-slot="date-picker-popup"
          role="dialog"
        >
          <PickerHeader
            headingClassName={sizeClassNames.heading}
            label={headerLabel}
            labels={labels.navigation[view]}
            onHeadingClick={handleHeaderClick}
            onNext={handleNext}
            onPrevious={handlePrev}
            view={view}
          />

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
                      "text-3xs py-1 text-center",
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
                  const isUnavailable = isDayDisabled(day.date);

                  return (
                    <button
                      aria-current={day.isToday ? "date" : undefined}
                      aria-disabled={isUnavailable || undefined}
                      aria-label={formatDayLabel(day.date)}
                      aria-selected={isSelected || undefined}
                      className={cn(
                        "flex size-8 items-center justify-center",
                        "rounded-full text-xs",
                        sizeClassNames.day,
                        "focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none",
                        isUnavailable
                          ? "text-foreground-disabled cursor-not-allowed"
                          : "hover:bg-muted cursor-pointer",
                        !day.isCurrentMonth &&
                          !isUnavailable &&
                          "text-foreground-disabled",
                        day.isWeekend &&
                          day.isCurrentMonth &&
                          !isUnavailable &&
                          !isSelected &&
                          "text-foreground-label",
                        day.isToday &&
                          !isSelected &&
                          !isUnavailable &&
                          "ring-foreground font-medium ring-1",
                        isSelected &&
                          "bg-primary text-primary-foreground hover:bg-primary/90",
                      )}
                      data-date={day.date}
                      key={day.date}
                      onClick={() => {
                        if (!isUnavailable) {
                          selectDay(day.date);
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
              cellClassName={sizeClassNames.cell}
              locale={locale}
              onSelect={handleMonthSelect}
              today={today}
              viewYear={viewYear}
            />
          )}

          {/* View: years */}
          {view === "years" && (
            <YearGrid
              currentYear={selectedYear}
              decadeBase={decadeBase}
              cellClassName={sizeClassNames.cell}
              onSelect={handleYearSelect}
              today={today}
            />
          )}

          {selection.mode === DATE_PICKER_MODE.dateTime && (
            <TimeField
              disabled={value === ""}
              label={labels.time}
              locale={locale}
              onChange={handleTimeChange}
              time={selection.time}
            />
          )}

          {/* Bottom row: today + clear */}
          <div className="mt-1 flex items-center gap-1 border-t pt-1">
            <Button
              className="flex-1"
              onClick={() => {
                const todayDate = Temporal.PlainDate.from(today);
                setViewMonthOverride({
                  month: todayDate.month - 1,
                  year: todayDate.year,
                });
                setView("days");
              }}
              size="xs"
              variant="ghost"
            >
              {todayLabel}
            </Button>
            {value && !hideClear && (
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
};

const DatePickerPopover = (props: DatePickerPopoverProps) => {
  const browserLocale = useHydrationSafeBrowserLocale();
  const today = useHydrationSafeToday();
  const locale = props.locale ?? browserLocale;

  return <DatePickerPopoverContent {...props} locale={locale} today={today} />;
};

export { DatePickerPopover };
export type { DatePickerPopoverProps };

// ---------------------------------------------------------------------------
// Helper sub-view components (placed after the exported component per convention)
// ---------------------------------------------------------------------------

// -- Header: [<] heading [>] --

const PickerHeader = ({
  headingClassName,
  label,
  labels,
  onHeadingClick,
  onNext,
  onPrevious,
  view,
}: {
  headingClassName: string;
  label: string;
  labels: NavigationLabels;
  onHeadingClick: () => void;
  onNext: () => void;
  onPrevious: () => void;
  view: PickerView;
}) => {
  // The decade is the top level: its heading has nowhere further to go.
  const isTopLevel = view === "years";
  return (
    <div className="flex items-center justify-between gap-1 pb-1">
      <Button
        aria-label={labels.previous}
        onClick={onPrevious}
        size="icon-xs"
        variant="ghost"
      >
        <DirectionalIcon icon={ChevronLeftIcon} />
      </Button>
      <button
        className={cn(
          "text-xs font-medium",
          isTopLevel
            ? "cursor-default"
            : "hover:bg-muted cursor-pointer rounded-md px-2 py-0.5",
          headingClassName,
        )}
        data-slot="date-picker-heading"
        onClick={onHeadingClick}
        tabIndex={isTopLevel ? -1 : 0}
        type="button"
      >
        {label}
      </button>
      <Button
        aria-label={labels.next}
        onClick={onNext}
        size="icon-xs"
        variant="ghost"
      >
        <DirectionalIcon icon={ChevronRightIcon} />
      </Button>
    </div>
  );
};

// -- Time row (date-time mode) --

/**
 * Hour and minute selects in the locale's own clock and numerals. Inert
 * until a day is picked, since a time alone is not a value.
 */
const TimeField = ({
  disabled,
  label,
  locale,
  onChange,
  time,
}: {
  disabled: boolean;
  label: string;
  locale: string;
  onChange: (clock: PickerClock) => void;
  time: string | null;
}) => {
  const labelId = useId();
  const hourOptions = useMemo(() => getHourOptions(locale), [locale]);
  const minuteOptions = useMemo(() => getMinuteOptions(locale), [locale]);
  const fieldNames = useMemo(() => getTimeFieldNames(locale), [locale]);
  const clock = time === null ? null : splitPickerTime(time);

  return (
    <div
      aria-labelledby={labelId}
      className="mt-1 flex items-center gap-1.5 border-t pt-1"
      role="group"
    >
      <span className="text-foreground-label shrink-0 text-xs" id={labelId}>
        {label}
      </span>
      <TimePartSelect
        disabled={disabled}
        label={fieldNames.hour}
        onChange={(hour) => onChange({ hour, minute: clock?.minute ?? 0 })}
        options={hourOptions}
        value={clock?.hour ?? null}
      />
      <span aria-hidden="true" className="text-muted-foreground text-xs">
        :
      </span>
      <TimePartSelect
        disabled={disabled}
        label={fieldNames.minute}
        onChange={(minute) => onChange({ hour: clock?.hour ?? 0, minute })}
        options={minuteOptions}
        value={clock?.minute ?? null}
      />
    </div>
  );
};

const TimePartSelect = ({
  disabled,
  label,
  onChange,
  options,
  value,
}: {
  disabled: boolean;
  label: string;
  onChange: (value: number) => void;
  options: PickerTimeOption[];
  value: number | null;
}) => (
  <Select
    disabled={disabled}
    onValueChange={(next) => {
      if (typeof next === "number") {
        onChange(next);
      }
    }}
    value={value}
  >
    <SelectTrigger aria-label={label} className="min-w-0 flex-1" size="sm">
      <SelectValue placeholder={"\u2014"} />
    </SelectTrigger>
    <SelectPopup>
      {options.map((option) => (
        <SelectItem key={option.value} value={option.value}>
          {option.label}
        </SelectItem>
      ))}
    </SelectPopup>
  </Select>
);

// -- Month picker grid (4×3) --

const MONTHS_PER_ROW = 3;

const MonthGrid = ({
  locale,
  viewYear,
  currentMonth,
  currentYear,
  cellClassName,
  onSelect,
  today,
}: {
  locale: string;
  cellClassName: string;
  viewYear: number;
  currentMonth: number | null;
  currentYear: number | null;
  onSelect: (month: number) => void;
  today: string;
}) => {
  const labels = useMemo(() => getMonthLabels(locale, "short"), [locale]);
  const now = Temporal.PlainDate.from(today);
  const todayMonth = now.month - 1;
  const todayYear = now.year;

  // Group months into rows of 3 for proper role="row" semantics
  const rows: number[][] = [];
  for (let r = 0; r < 12; r += MONTHS_PER_ROW) {
    rows.push(Array.from({ length: MONTHS_PER_ROW }, (_, c) => r + c));
  }

  return (
    <div className="grid grid-cols-3 gap-1 py-1" role="grid">
      {rows.map((row) => (
        <div className="contents" key={row[0]} role="row">
          {row.map((month) => {
            const isSelected =
              currentMonth !== null &&
              currentYear !== null &&
              month === currentMonth &&
              viewYear === currentYear;
            const isNow = month === todayMonth && viewYear === todayYear;
            return (
              <button
                aria-selected={isSelected || undefined}
                className={cn(
                  "rounded-md px-2 py-1.5 text-xs",
                  cellClassName,
                  "hover:bg-muted cursor-pointer",
                  "focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none",
                  isNow && !isSelected && "ring-foreground font-medium ring-1",
                  isSelected &&
                    "bg-primary text-primary-foreground hover:bg-primary/90",
                )}
                key={month}
                onClick={() => onSelect(month)}
                role="gridcell"
                type="button"
              >
                {!/^\d/u.test(labels[month] ?? "") && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "text-3xs me-1 tabular-nums opacity-50",
                      !isSelected && "text-muted-foreground",
                    )}
                  >
                    {month + 1}
                  </span>
                )}
                {labels[month]}
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
  cellClassName,
  onSelect,
  today,
}: {
  decadeBase: number;
  cellClassName: string;
  currentYear: number | null;
  onSelect: (year: number) => void;
  today: string;
}) => {
  const todayYear = Temporal.PlainDate.from(today).year;
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
                  "rounded-md px-2 py-1.5 text-xs",
                  cellClassName,
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
