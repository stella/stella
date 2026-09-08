import { Temporal } from "@stll/time";

export const localISODate = (date?: Date): string => {
  const instant =
    date === undefined
      ? Temporal.Now.instant()
      : Temporal.Instant.fromEpochMilliseconds(date.getTime());
  return instant
    .toZonedDateTimeISO(Temporal.Now.timeZoneId())
    .toPlainDate()
    .toString();
};
