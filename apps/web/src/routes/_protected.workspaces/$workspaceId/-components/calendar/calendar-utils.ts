/**
 * Calendar date utilities.
 *
 * All date arithmetic uses UTC to avoid timezone-induced
 * off-by-one errors (ISO date strings from the backend are
 * datestamp-only, no time component).
 */

import type { WorkspaceFieldContent } from "@/lib/types";
import { includesValue } from "@/lib/utils";

export type CalendarDay = {
  /** ISO date string (YYYY-MM-DD) */
  date: string;
  /** Whether this day belongs to the displayed month */
  isCurrentMonth: boolean;
  isToday: boolean;
  /** Saturday (index 5) or Sunday (index 6) in Mon-first layout */
  isWeekend: boolean;
};

const toISODate = (d: Date): string => d.toISOString().slice(0, 10);

const todayISO = (): string => toISODate(new Date());

/**
 * Returns all days to display in a month grid (6 weeks max).
 * Weeks start on Monday (ISO standard).
 */
export const getMonthDays = (year: number, month: number): CalendarDay[] => {
  const today = todayISO();
  const days: CalendarDay[] = [];

  // First day of the month
  const first = new Date(Date.UTC(year, month, 1));
  // Day of week: 0=Sun..6=Sat → shift to Mon=0..Sun=6
  const startDow = (first.getUTCDay() + 6) % 7;

  // Go back to Monday of the first week
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - startDow);

  // Always render 6 weeks (42 days) for consistent grid height
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = toISODate(d);
    const dow = i % 7;
    days.push({
      date: iso,
      isCurrentMonth: d.getUTCMonth() === month,
      isToday: iso === today,
      isWeekend: dow >= 5,
    });
  }

  return days;
};

/**
 * Returns all days to display in a week view.
 * The week containing `referenceDate` (Mon–Sun).
 */
export const getWeekDays = (referenceDate: Date): CalendarDay[] => {
  const today = todayISO();
  const dow = (referenceDate.getUTCDay() + 6) % 7;
  const monday = new Date(referenceDate);
  monday.setUTCDate(monday.getUTCDate() - dow);

  const days: CalendarDay[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = toISODate(d);
    days.push({
      date: iso,
      isCurrentMonth: true,
      isToday: iso === today,
      isWeekend: i >= 5,
    });
  }
  return days;
};

/**
 * Extract a date string from an entity for a given property ID.
 * Handles both custom date properties and internal properties.
 */
/** Coerce a Date or ISO string to YYYY-MM-DD. */
const toDateString = (value: string | Date): string => {
  if (value instanceof Date) {
    return toISODate(value);
  }
  return value.slice(0, 10);
};

export const getEntityDate = (
  entity: {
    fields: Record<string, { content: WorkspaceFieldContent }>;
    createdAt: string | Date;
    updatedAt: string | Date | null;
    dueDate?: string | Date | null;
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
 * `_start-date` is retained for timeline/calendar configuration
 * but no longer has a built-in entity field backing it.
 */
export const TASK_DATE_IDS = ["_due-date", "_start-date"] as const;

export const isTaskDateProperty = (id: string) =>
  includesValue(TASK_DATE_IDS, id);

/**
 * Localized weekday header labels (Mon–Sun, short).
 * Uses `Intl.DateTimeFormat` so labels follow the active locale.
 * 2024-01-01 is a Monday; we generate Mon→Sun from there.
 */
export const getWeekdayLabels = (locale: string): string[] => {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.UTC(2024, 0, 1 + i));
    return fmt.format(d);
  });
};
