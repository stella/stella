import { Temporal } from "@stll/time";

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

export const startOfUTCMonth = (date: Temporal.PlainDate): Temporal.PlainDate =>
  date.with({ day: 1 });

export const addUTCMonths = (
  date: Temporal.PlainDate,
  amount: number,
): Temporal.PlainDate => {
  const next = startOfUTCMonth(date);
  return next.add({ months: amount });
};

export const getCenteredMonthWindowStart = (
  date: Temporal.PlainDate,
): Temporal.PlainDate => addUTCMonths(date, -MONTH_WINDOW_CENTER);

export const getMonthDistance = (
  from: Temporal.PlainDate,
  to: Temporal.PlainDate,
): number => (to.year - from.year) * 12 + (to.month - from.month);

export const getMonthWindowStartContaining = (
  windowStart: Temporal.PlainDate,
  targetMonth: Temporal.PlainDate,
): Temporal.PlainDate => {
  const distance = getMonthDistance(windowStart, targetMonth);
  if (distance >= 0 && distance < MONTH_WINDOW_SIZE) {
    return windowStart;
  }

  return getCenteredMonthWindowStart(targetMonth);
};

export const getUTCMonthKey = (date: Temporal.PlainDate): string =>
  `${date.year}-${String(date.month).padStart(2, "0")}`;

const toUTCDateKey = (date: Temporal.PlainDate): string => date.toString();

const startOfUTCWeek = (
  date: Temporal.PlainDate,
  firstWeekday: number,
): Temporal.PlainDate => {
  const offset = ((date.dayOfWeek % 7) - firstWeekday + 7) % 7;
  return date.subtract({ days: offset });
};

const addUTCDays = (
  date: Temporal.PlainDate,
  amount: number,
): Temporal.PlainDate => date.add({ days: amount });

const getContinuousWeekDays = (
  weekStart: Temporal.PlainDate,
  weekend: ReadonlySet<number>,
): CalendarDay[] => {
  const today = Temporal.Now.instant()
    .toZonedDateTimeISO("UTC")
    .toPlainDate()
    .toString();

  return Array.from({ length: 7 }, (_, index) => {
    const date = addUTCDays(weekStart, index);
    const key = toUTCDateKey(date);
    const month = date.month - 1;
    const startsMonth = date.day === 1;
    const monthTone = month % 2 === 0 ? "muted" : null;

    return {
      date: key,
      isCurrentMonth: true,
      isToday: key === today,
      ...(startsMonth && { startsMonth }),
      ...(monthTone && { monthTone }),
      isWeekend: weekend.has(date.dayOfWeek % 7),
    };
  });
};

export const getMonthAnchors = (
  locale: string,
  windowStart: Temporal.PlainDate,
): MonthAnchor[] => {
  const firstWeekday = getFirstWeekday(locale);

  return Array.from({ length: MONTH_WINDOW_SIZE }, (_, index) => {
    const date = addUTCMonths(windowStart, index);
    const year = date.year;
    const month = date.month - 1;

    return {
      column: ((date.dayOfWeek % 7) - firstWeekday + 7) % 7,
      key: getUTCMonthKey(date),
      label: formatMonthYearLabel(locale, year, month),
      month,
      year,
    };
  });
};

export const getMonthWeekRows = (
  locale: string,
  windowStart: Temporal.PlainDate,
): CalendarWeekRow[] => {
  const firstWeekday = getFirstWeekday(locale);
  const weekend = getWeekendDays(locale);
  const anchors = getMonthAnchors(locale, windowStart);
  const anchorsByWeek = new Map<string, MonthAnchor[]>();

  for (const anchor of anchors) {
    const anchorDate = Temporal.PlainDate.from({
      year: anchor.year,
      month: anchor.month + 1,
      day: 1,
    });
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
    lastMonth.with({ day: lastMonth.daysInMonth }),
    firstWeekday,
  );

  for (
    let weekStart = firstWeekStart;
    Temporal.PlainDate.compare(weekStart, lastWeekStart) <= 0;
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
