/**
 * Calendar date utilities.
 *
 * All date arithmetic uses UTC to avoid timezone-induced
 * off-by-one errors (ISO date strings from the backend are
 * datestamp-only, no time component).
 */

import type { TaskStatus } from "@stll/api-contract";
import { Temporal } from "@stll/time";

import { getFirstWeekday } from "@/i18n/week";
import type { WorkspaceFieldContent } from "@/lib/types";
import { includesValue } from "@/lib/utils";

export type CalendarDay = {
  /** ISO date string (YYYY-MM-DD) */
  date: string;
  /** Whether this day belongs to the displayed month */
  isCurrentMonth: boolean;
  isToday: boolean;
  /** Whether this day starts a new month in continuous views. */
  startsMonth?: boolean;
  /** Alternating visual band for continuous month scrolling. */
  monthTone?: "muted";
  /** Falls on the locale's weekend, derived from the actual day of week. */
  isWeekend: boolean;
};

const toISODate = (date: Temporal.PlainDate): string => date.toString();
const toUTCDateTime = (date: Temporal.PlainDate): number =>
  date.toZonedDateTime({
    plainTime: Temporal.PlainTime.from("00:00"),
    timeZone: "UTC",
  }).epochMilliseconds;

const todayISO = (): string => Temporal.Now.plainDateISO("UTC").toString();

/**
 * Returns all days to display in a month grid (6 weeks max).
 * Weeks start on the locale's first weekday.
 */
export const getMonthDays = (
  year: number,
  month: number,
  firstWeekday: number,
  weekend: ReadonlySet<number>,
): CalendarDay[] => {
  const today = todayISO();
  const days: CalendarDay[] = [];

  // First day of the month
  const first = Temporal.PlainDate.from({ year, month: month + 1, day: 1 });
  // Column within the week, rotated to the locale's first weekday.
  const startDow = ((first.dayOfWeek % 7) - firstWeekday + 7) % 7;

  // Go back to the first weekday of the first week
  const start = first.subtract({ days: startDow });

  // Always render 6 weeks (42 days) for consistent grid height
  for (let i = 0; i < 42; i++) {
    const d = start.add({ days: i });
    const iso = toISODate(d);
    const dayOfWeek = d.dayOfWeek % 7;
    days.push({
      date: iso,
      isCurrentMonth: d.month === month + 1,
      isToday: iso === today,
      isWeekend: weekend.has(dayOfWeek),
    });
  }

  return days;
};

/**
 * Returns all days to display in a week view.
 * The week containing `referenceDate`, starting on the locale's
 * first weekday.
 */
export const getWeekDays = (
  referenceDate: Temporal.PlainDate,
  firstWeekday: number,
  weekend: ReadonlySet<number>,
): CalendarDay[] => {
  const today = todayISO();
  const dow = ((referenceDate.dayOfWeek % 7) - firstWeekday + 7) % 7;
  const weekStart = referenceDate.subtract({ days: dow });

  const days: CalendarDay[] = [];
  for (let i = 0; i < 7; i++) {
    const d = weekStart.add({ days: i });
    const iso = toISODate(d);
    const dayOfWeek = d.dayOfWeek % 7;
    days.push({
      date: iso,
      isCurrentMonth: true,
      isToday: iso === today,
      isWeekend: weekend.has(dayOfWeek),
    });
  }
  return days;
};

// Keyed by locale + serialized options: the calendar grid only ever
// requests a handful of distinct (locale, options) pairs (month labels,
// weekday labels, the month/year header), so the cache stays tiny.
const dateFormatterCache: Record<string, Intl.DateTimeFormat> = {};

const getDateFormatter = (
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat => {
  const cacheKey = `${locale}:${JSON.stringify(options)}`;
  return (dateFormatterCache[cacheKey] ??= new Intl.DateTimeFormat(
    locale,
    options,
  ));
};

export const getMonthLabels = (
  locale: string,
  year: number,
  format: "short" | "long",
): string[] => {
  const fmt = getDateFormatter(locale, {
    month: format,
    // The grid is Gregorian; pin labels so a Hijri preference does not
    // mislabel Gregorian months (numerals still follow the locale).
    calendar: "gregory",
    timeZone: "UTC",
  });

  return Array.from({ length: 12 }, (_, i) => {
    const d = Temporal.PlainDate.from({ year, month: i + 1, day: 1 });
    return fmt.format(toUTCDateTime(d));
  });
};

export const formatMonthYearLabel = (
  locale: string,
  year: number,
  month: number,
): string =>
  getDateFormatter(locale, {
    month: "long",
    year: "numeric",
    // Gregorian grid; keep the header on the Gregorian calendar.
    calendar: "gregory",
    timeZone: "UTC",
  }).format(
    toUTCDateTime(Temporal.PlainDate.from({ year, month: month + 1, day: 1 })),
  );

export const appendToMapArray = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const bucket = map.get(key);
  if (bucket) {
    bucket.push(value);
    return;
  }

  map.set(key, [value]);
};

/**
 * Extract a date string from an entity for a given property ID.
 * Handles both custom date properties and internal properties.
 */
/** Coerce a Date or ISO string to YYYY-MM-DD. */
const toDateString = (value: string | Date): string => {
  if (value instanceof Date) {
    return Temporal.Instant.fromEpochMilliseconds(value.getTime())
      .toZonedDateTimeISO("UTC")
      .toPlainDate()
      .toString();
  }
  return value.slice(0, 10);
};

export const getEntityDate = (
  entity: {
    fields: Record<string, { content: WorkspaceFieldContent }>;
    createdAt: string | Date;
    updatedAt: string | Date | null;
    dueDate?: string | Date | null;
    startAt?: string | Date | null;
    occurredAt?: string | Date | null;
  },
  propertyId: string,
): string | null => {
  if (propertyId === INTERNAL_DATE_IDS[0]) {
    return toDateString(entity.createdAt);
  }
  if (propertyId === INTERNAL_DATE_IDS[1]) {
    return entity.updatedAt !== null ? toDateString(entity.updatedAt) : null;
  }
  if (propertyId === TASK_DATE_IDS[0]) {
    return entity.dueDate !== null && entity.dueDate !== undefined
      ? toDateString(entity.dueDate)
      : null;
  }
  if (propertyId === TASK_DATE_IDS[1]) {
    const value = entity.startAt ?? entity.occurredAt ?? entity.dueDate;
    return value !== null && value !== undefined ? toDateString(value) : null;
  }

  const field = entity.fields[propertyId];
  if (field?.content.type === "date" && field.content.value) {
    return toDateString(field.content.value);
  }

  return null;
};

/**
 * Internal date pseudo-properties (`_created-at`, `_updated-at`)
 * are read-only metadata; drag/resize/create should be disabled.
 */
export const INTERNAL_DATE_IDS = ["_created-at", "_updated-at"] as const;

export const isInternalDateProperty = (id: string) =>
  includesValue(INTERNAL_DATE_IDS, id);

/**
 * Built-in task date pseudo-properties (`_due-date`, `_start-date`).
 * `_due-date` maps to the task entity's native `dueDate` field.
 * `_start-date` maps to the agenda `startAt` field and falls back
 * to `occurredAt` for imported historical items.
 */
export const TASK_DATE_IDS = ["_due-date", "_start-date"] as const;

export const isTaskDateProperty = (id: string) =>
  includesValue(TASK_DATE_IDS, id);

/**
 * Localized weekday header labels, starting at the locale's first
 * weekday. Uses `Intl.DateTimeFormat` so labels follow the active locale.
 * 2024-01-07 is a Sunday (day-of-week 0); offsetting by the first
 * weekday yields labels starting from that day.
 */
export const TASK_STATUS_DOT_COLORS = {
  open: "var(--option-gray)",
  in_progress: "var(--option-blue)",
  in_review: "var(--option-amber)",
  done: "var(--option-emerald)",
  cancelled: "var(--option-red)",
} as const satisfies Record<TaskStatus, string>;

export const getWeekdayLabels = (
  locale: string,
  format: "short" | "narrow" = "short",
): string[] => {
  const firstWeekday = getFirstWeekday(locale);
  const fmt = getDateFormatter(locale, {
    weekday: format,
    timeZone: "UTC",
  });
  return Array.from({ length: 7 }, (_, i) => {
    const d = Temporal.PlainDate.from("2024-01-07").add({
      days: firstWeekday + i,
    });
    return fmt.format(toUTCDateTime(d));
  });
};
