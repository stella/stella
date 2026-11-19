import { parsePlainDate, Temporal } from "@stll/time";

const DAYS_PER_WEEK = 7;

/** Today in the person's own zone, YYYY-MM-DD; it also bounds the week's activity. */
export const todayIn = (timezoneId: string) =>
  Temporal.Now.plainDateISO(timezoneId).toString();

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

export const plainWeekDate = (date: unknown): string | undefined =>
  typeof date === "string" && parsePlainDate(date) !== null ? date : undefined;
