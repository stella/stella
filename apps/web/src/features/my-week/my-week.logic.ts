import { Temporal } from "@stll/time";

const DAYS_PER_WEEK = 7;

export type Week = {
  /** Monday of the week, YYYY-MM-DD. */
  start: string;
  /** Sunday of the week, YYYY-MM-DD. */
  end: string;
  /** Monday through Sunday, YYYY-MM-DD. */
  days: string[];
};

/** The Monday-to-Sunday week that contains `date`. */
export const weekOf = (date: string): Week => {
  const day = Temporal.PlainDate.from(date);
  const monday = day.subtract({ days: day.dayOfWeek - 1 });
  const days = Array.from({ length: DAYS_PER_WEEK }, (_, index) =>
    monday.add({ days: index }).toString(),
  );
  return {
    start: monday.toString(),
    end: monday.add({ days: DAYS_PER_WEEK - 1 }).toString(),
    days,
  };
};

/** The same weekday `weeks` weeks away, so moving keeps the opened day. */
export const shiftWeeks = (date: string, weeks: number) =>
  Temporal.PlainDate.from(date).add({ weeks }).toString();

type DayTotal = {
  dateWorked: string;
  loggedMinutes: number;
  billableMinutes: number;
};

export type WeekTotals = {
  loggedMinutes: number;
  billableMinutes: number;
  byDay: ReadonlyMap<string, number>;
};

/** Week and per-day totals from the server's per-date sums. */
/** Minutes of the entries loaded so far for a day. */
export const loadedMinutes = (
  entries: readonly { durationMinutes: number }[],
) => {
  let total = 0;
  for (const { durationMinutes } of entries) {
    total += durationMinutes;
  }
  return total;
};

export const weekTotals = (days: readonly DayTotal[]): WeekTotals => {
  let loggedMinutes = 0;
  let billableMinutes = 0;
  const byDay = new Map<string, number>();
  for (const day of days) {
    loggedMinutes += day.loggedMinutes;
    billableMinutes += day.billableMinutes;
    byDay.set(day.dateWorked, day.loggedMinutes);
  }
  return { loggedMinutes, billableMinutes, byDay };
};

type SuggestionDay = { date: string; matters: { items: unknown[] }[] };

/** Pending suggestions per date, for the week strip. */
export const pendingCountByDay = (
  days: readonly SuggestionDay[],
): ReadonlyMap<string, number> =>
  new Map(
    days.map((day) => [
      day.date,
      day.matters.reduce((sum, matter) => sum + matter.items.length, 0),
    ]),
  );
