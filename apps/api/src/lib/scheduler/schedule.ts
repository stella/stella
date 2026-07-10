import { panic } from "better-result";

import type {
  SchedulerDailySchedule,
  SchedulerSchedule,
} from "@/api/db/schema";
import { DAY_IN_MS } from "@/api/lib/time";

const MINUTE_MS = 60 * 1000;

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export const computeNextRunAt = (
  schedule: SchedulerSchedule,
  from = new Date(),
): Date => {
  if (schedule.type === "interval") {
    if (!Number.isFinite(schedule.everyMs) || schedule.everyMs < MINUTE_MS) {
      return panic("Scheduler interval must be at least one minute");
    }

    return new Date(from.getTime() + schedule.everyMs);
  }

  return computeNextDailyRunAt(schedule, from);
};

const computeNextDailyRunAt = (
  schedule: SchedulerDailySchedule,
  from: Date,
): Date => {
  validateDailySchedule(schedule);

  const localNow = getLocalDateTime(from, schedule.timeZone);
  const localTarget = {
    ...localNow,
    hour: schedule.hour,
    minute: schedule.minute,
    second: 0,
  };

  const candidate = zonedDateTimeToUtc(localTarget, schedule.timeZone);
  if (candidate.getTime() > from.getTime()) {
    return candidate;
  }

  return zonedDateTimeToUtc(addLocalDays(localTarget, 1), schedule.timeZone);
};

const validateDailySchedule = ({
  hour,
  minute,
  timeZone,
}: SchedulerDailySchedule): void => {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return panic("Scheduler daily hour must be between 0 and 23");
  }

  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    return panic("Scheduler daily minute must be between 0 and 59");
  }

  if (timeZone.trim() === "") {
    return panic("Scheduler daily timeZone must not be empty");
  }
};

const getLocalDateTime = (instant: Date, timeZone: string): LocalDateTime => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);

  return {
    year: getDatePart(parts, "year"),
    month: getDatePart(parts, "month"),
    day: getDatePart(parts, "day"),
    hour: getDatePart(parts, "hour"),
    minute: getDatePart(parts, "minute"),
    second: getDatePart(parts, "second"),
  };
};

const getDatePart = (
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): number => {
  const part = parts.find((item) => item.type === type);
  if (!part) {
    return panic(`Missing ${type} in formatted scheduler date`);
  }

  const value = Number.parseInt(part.value, 10);
  if (!Number.isInteger(value)) {
    return panic(`Invalid ${type} in formatted scheduler date`);
  }

  return value;
};

const getOffsetMs = (utcMs: number, timeZone: string): number =>
  localAsUtcMs(getLocalDateTime(new Date(utcMs), timeZone)) - utcMs;

const zonedDateTimeToUtc = (
  localDateTime: LocalDateTime,
  timeZone: string,
): Date => {
  // Interpret the wall-clock time as if it were UTC, then correct by the
  // zone offset. Sampling the offset a day before and after disambiguates
  // DST transitions: a previous fixed-point iteration could not converge on
  // a non-existent (spring-forward) wall time and landed before the gap,
  // skipping the run. Gaps now roll forward to the next valid instant;
  // overlaps (fall-back) take the first occurrence.
  const naiveMs = localAsUtcMs(localDateTime);
  const guessBefore = naiveMs - getOffsetMs(naiveMs - DAY_IN_MS, timeZone);
  const guessAfter = naiveMs - getOffsetMs(naiveMs + DAY_IN_MS, timeZone);

  const mapsBack = (utcMs: number): boolean =>
    localAsUtcMs(getLocalDateTime(new Date(utcMs), timeZone)) === naiveMs;

  const beforeValid = mapsBack(guessBefore);
  const afterValid = mapsBack(guessAfter);

  if (beforeValid && afterValid) {
    return new Date(Math.min(guessBefore, guessAfter));
  }
  if (beforeValid) {
    return new Date(guessBefore);
  }
  if (afterValid) {
    return new Date(guessAfter);
  }
  return new Date(Math.max(guessBefore, guessAfter));
};

const localAsUtcMs = ({
  day,
  hour,
  minute,
  month,
  second,
  year,
}: LocalDateTime): number =>
  Date.UTC(year, month - 1, day, hour, minute, second);

const addLocalDays = (
  localDateTime: LocalDateTime,
  days: number,
): LocalDateTime => {
  const shifted = new Date(localAsUtcMs(localDateTime) + days * DAY_IN_MS);

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
};
