import { panic } from "better-result";

import { Temporal } from "@stll/time";

import type {
  SchedulerDailySchedule,
  SchedulerSchedule,
} from "@/api/db/schema";

const MINUTE_MS = 60 * 1000;

// The scheduler persists Drizzle timestamps; keep Date at this boundary only.
export const computeNextRunAt = (
  schedule: SchedulerSchedule,
  from = new Date(),
): Date => {
  const instant = Temporal.Instant.fromEpochMilliseconds(from.getTime());
  if (schedule.type === "interval") {
    if (!Number.isFinite(schedule.everyMs) || schedule.everyMs < MINUTE_MS) {
      return panic("Scheduler interval must be at least one minute");
    }
    // Intervals already accept fractional milliseconds. Preserve their
    // millisecond clipping at the persisted Date boundary.
    const next = Temporal.Instant.fromEpochMilliseconds(
      Math.trunc(instant.epochMilliseconds + schedule.everyMs),
    );
    return new Date(next.epochMilliseconds);
  }

  validateDailySchedule(schedule);
  const date = instant.toZonedDateTimeISO(schedule.timeZone).toPlainDate();
  const time = Temporal.PlainTime.from({
    hour: schedule.hour,
    minute: schedule.minute,
  });
  // Compatible disambiguation moves spring gaps forward and chooses the first
  // occurrence in autumn overlaps. Resolve each date independently: adding a
  // day to a gap-adjusted 03:30 would incorrectly keep tomorrow at 03:30.
  const candidate = date
    .toPlainDateTime(time)
    .toZonedDateTime(schedule.timeZone, {
      disambiguation: "compatible",
    });
  const next =
    Temporal.Instant.compare(candidate.toInstant(), instant) > 0
      ? candidate
      : date
          .add({ days: 1 })
          .toPlainDateTime(time)
          .toZonedDateTime(schedule.timeZone, {
            disambiguation: "compatible",
          });
  return new Date(next.epochMilliseconds);
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
