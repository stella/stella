import { getFirstWeekday, getWeekendDays } from "@/i18n/week";
import { normalizeOptionalArray } from "@/lib/arrays";

import type { CalendarDay } from "./calendar-utils";
import { formatMonthYearLabel } from "./calendar-utils";

export type MonthAnchor = {
  column: number;
  key: string;
  label: string;
  month: number;
  year: number;
};

export type CalendarWeekRow = {
  key: string;
  anchors: MonthAnchor[];
  days: CalendarDay[];
};

export const MONTH_WINDOW_SIZE = 9;
export const MONTH_WINDOW_SHIFT = 3;
export const MONTH_WINDOW_CENTER = Math.floor(MONTH_WINDOW_SIZE / 2);

export const startOfUTCMonth = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));

export const addUTCMonths = (date: Date, amount: number): Date => {
  const next = startOfUTCMonth(date);
  next.setUTCMonth(next.getUTCMonth() + amount);
  return next;
};

export const getCenteredMonthWindowStart = (date: Date): Date =>
  addUTCMonths(date, -MONTH_WINDOW_CENTER);

export const getMonthDistance = (from: Date, to: Date): number =>
  (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
  (to.getUTCMonth() - from.getUTCMonth());

export const getMonthWindowStartContaining = (
  windowStart: Date,
  targetMonth: Date,
): Date => {
  const distance = getMonthDistance(windowStart, targetMonth);
  if (distance >= 0 && distance < MONTH_WINDOW_SIZE) {
    return windowStart;
  }

  return getCenteredMonthWindowStart(targetMonth);
};

export const getUTCMonthKey = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

const toUTCDateKey = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

const startOfUTCWeek = (date: Date, firstWeekday: number): Date => {
  const start = new Date(date);
  const offset = (start.getUTCDay() - firstWeekday + 7) % 7;
  start.setUTCDate(start.getUTCDate() - offset);
  return start;
};

const addUTCDays = (date: Date, amount: number): Date => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + amount);
  return next;
};

const getContinuousWeekDays = (
  weekStart: Date,
  weekend: ReadonlySet<number>,
): CalendarDay[] => {
  const today = toUTCDateKey(new Date());

  return Array.from({ length: 7 }, (_, index) => {
    const date = addUTCDays(weekStart, index);
    const key = toUTCDateKey(date);
    const month = date.getUTCMonth();
    const startsMonth = date.getUTCDate() === 1;
    const monthTone = month % 2 === 0 ? "muted" : null;

    return {
      date: key,
      isCurrentMonth: true,
      isToday: key === today,
      ...(startsMonth && { startsMonth }),
      ...(monthTone && { monthTone }),
      isWeekend: weekend.has(date.getUTCDay()),
    };
  });
};

export const getMonthAnchors = (
  locale: string,
  windowStart: Date,
): MonthAnchor[] => {
  const firstWeekday = getFirstWeekday(locale);

  return Array.from({ length: MONTH_WINDOW_SIZE }, (_, index) => {
    const date = addUTCMonths(windowStart, index);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();

    return {
      column: (date.getUTCDay() - firstWeekday + 7) % 7,
      key: getUTCMonthKey(date),
      label: formatMonthYearLabel(locale, year, month),
      month,
      year,
    };
  });
};

export const getMonthWeekRows = (
  locale: string,
  windowStart: Date,
): CalendarWeekRow[] => {
  const firstWeekday = getFirstWeekday(locale);
  const weekend = getWeekendDays(locale);
  const anchors = getMonthAnchors(locale, windowStart);
  const anchorsByWeek = new Map<string, MonthAnchor[]>();

  for (const anchor of anchors) {
    const anchorDate = new Date(Date.UTC(anchor.year, anchor.month, 1));
    const weekKey = toUTCDateKey(startOfUTCWeek(anchorDate, firstWeekday));
    const bucket = anchorsByWeek.get(weekKey);
    if (bucket) {
      bucket.push(anchor);
      continue;
    }

    anchorsByWeek.set(weekKey, [anchor]);
  }

  const rows: CalendarWeekRow[] = [];
  const firstWeekStart = startOfUTCWeek(windowStart, firstWeekday);
  const lastMonth = addUTCMonths(windowStart, MONTH_WINDOW_SIZE - 1);
  const lastWeekStart = startOfUTCWeek(
    new Date(
      Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + 1, 0),
    ),
    firstWeekday,
  );

  for (
    let weekStart = firstWeekStart;
    weekStart <= lastWeekStart;
    weekStart = addUTCDays(weekStart, 7)
  ) {
    const key = toUTCDateKey(weekStart);
    const storedAnchors = anchorsByWeek.get(key);
    rows.push({
      key,
      anchors: normalizeOptionalArray(storedAnchors),
      days: getContinuousWeekDays(weekStart, weekend),
    });
  }

  return rows;
};
