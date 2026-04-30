import { panic } from "better-result";

import type {
  SchedulerDailySchedule,
  SchedulerSchedule,
} from "@/api/db/schema";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
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

const zonedDateTimeToUtc = (
  localDateTime: LocalDateTime,
  timeZone: string,
): Date => {
  const targetLocalMs = localAsUtcMs(localDateTime);
  let utcMs = targetLocalMs;

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actualLocalMs = localAsUtcMs(
      getLocalDateTime(new Date(utcMs), timeZone),
    );
    const diffMs = targetLocalMs - actualLocalMs;

    if (diffMs === 0) {
      break;
    }

    utcMs += diffMs;
  }

  return new Date(utcMs);
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
  const shifted = new Date(localAsUtcMs(localDateTime) + days * ONE_DAY_MS);

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
};
