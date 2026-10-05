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

export const DATE_PICKER_MODE = Object.freeze({
  date: "date",
  dateTime: "date-time",
} as const);

export type DatePickerMode =
  (typeof DATE_PICKER_MODE)[keyof typeof DATE_PICKER_MODE];

/** The time a date-time value takes when a day is picked before any time. */
export const DEFAULT_PICKER_TIME = "00:00";

/** A wall-clock selection: an ISO date plus an `HH:mm` time. */
export type DateTimeSelection = {
  date: string;
  time: string;
};

/**
 * Read a date-time value (`YYYY-MM-DDTHH:mm`, a zone-less
 * `Temporal.PlainDateTime`). A bare date reads as midnight and seconds are
 * dropped. An instant (`…Z`) is not a wall-clock time and throws, like any
 * other malformed value.
 */
export const parseDateTimeValue = (
  value: string | null,
): DateTimeSelection | null => {
  if (value === null || value === "") {
    return null;
  }
  const dateTime = Temporal.PlainDateTime.from(value);
  return {
    date: dateTime.toPlainDate().toString(),
    time: dateTime.toPlainTime().toString({ smallestUnit: "minute" }),
  };
};

export const formatDateTimeValue = ({
  date,
  time,
}: DateTimeSelection): string => `${date}T${time}`;

export type PickerClock = {
  hour: number;
  minute: number;
};

export const splitPickerTime = (time: string): PickerClock => {
  const { hour, minute } = Temporal.PlainTime.from(time);
  return { hour, minute };
};

export const joinPickerTime = (clock: PickerClock): string =>
  Temporal.PlainTime.from(clock).toString({ smallestUnit: "minute" });

export type PickerTimeOption = {
  value: number;
  label: string;
};

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const MINUTES = Array.from({ length: 60 }, (_, minute) => minute);

/**
 * Hour choices in the locale's own clock: `2 PM` where the locale counts
 * twelve hours, `14` where it counts twenty-four.
 */
export const getHourOptions = (locale: string): PickerTimeOption[] => {
  const formatter = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    timeZone: "UTC",
  });
  const epoch = Temporal.PlainDate.from("1970-01-01");
  return HOURS.map((hour) => ({
    value: hour,
    label: formatter.format(
      epoch.toZonedDateTime({
        plainTime: Temporal.PlainTime.from({ hour }),
        timeZone: "UTC",
      }).epochMilliseconds,
    ),
  }));
};

/** Two-digit minute choices in the locale's numbering system. */
export const getMinuteOptions = (locale: string): PickerTimeOption[] => {
  const formatter = new Intl.NumberFormat(locale, {
    minimumIntegerDigits: 2,
    useGrouping: false,
  });
  return MINUTES.map((minute) => ({
    value: minute,
    label: formatter.format(minute),
  }));
};

const capitalize = (locale: string, text: string): string =>
  text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);

/** Accessible names of the hour and minute fields, from the locale itself. */
export const getTimeFieldNames = (
  locale: string,
): Record<keyof PickerClock, string> => {
  const names = new Intl.DisplayNames(locale, { type: "dateTimeField" });
  return {
    hour: capitalize(locale, names.of("hour") ?? "hour"),
    minute: capitalize(locale, names.of("minute") ?? "minute"),
  };
};
