import { Temporal } from "temporal-polyfill/full";

const DATE_ROLLOVER_EPSILON_MS = 50;

export type CalendarMonth = {
  month: number;
  year: number;
};

const padDatePart = (value: number): string =>
  value.toString().padStart(2, "0");

export const localDateFromTimestamp = (timestamp: number): string => {
  const current = Temporal.Instant.fromEpochMilliseconds(
    timestamp,
  ).toZonedDateTimeISO(Temporal.Now.timeZoneId());
  return [
    current.year,
    padDatePart(current.month),
    padDatePart(current.day),
  ].join("-");
};

const calendarMonthFromDate = (date: string): CalendarMonth => {
  const current = Temporal.PlainDate.from(date);
  return { month: current.month - 1, year: current.year };
};

export const resolveCalendarViewMonth = ({
  override,
  today,
  value,
}: {
  override: CalendarMonth | null;
  today: string;
  value: string;
}): CalendarMonth => override ?? calendarMonthFromDate(value || today);

export const shiftCalendarDate = (
  date: string,
  options: { months?: number; years?: number },
): string => Temporal.PlainDate.from(date).add(options).toString();

export const millisecondsUntilNextLocalDate = (timestamp: number): number => {
  const current = Temporal.Instant.fromEpochMilliseconds(
    timestamp,
  ).toZonedDateTimeISO(Temporal.Now.timeZoneId());
  const nextLocalDate = current
    .toPlainDate()
    .add({ days: 1 })
    .toZonedDateTime({
      plainTime: Temporal.PlainTime.from("00:00"),
      timeZone: current.timeZoneId,
    });
  return (
    Math.max(0, nextLocalDate.epochMilliseconds - timestamp) +
    DATE_ROLLOVER_EPSILON_MS
  );
};
