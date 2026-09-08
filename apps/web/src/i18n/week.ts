import { Temporal } from "@stll/time";
import { getFirstWeekday, getWeekendDays } from "@stll/ui/week";

export { getFirstWeekday, getWeekendDays };

/**
 * Midnight at the start of the week containing `date`, honoring the
 * locale's first weekday (local time).
 */
export const startOfWeek = (
  date: Date | Temporal.PlainDate,
  locale: string,
): Temporal.PlainDate => {
  const firstWeekday = getFirstWeekday(locale);
  const plainDate =
    date instanceof Date
      ? Temporal.Instant.fromEpochMilliseconds(date.getTime())
          .toZonedDateTimeISO(Temporal.Now.timeZoneId())
          .toPlainDate()
      : date;
  const diff = ((plainDate.dayOfWeek % 7) - firstWeekday + 7) % 7;
  return plainDate.subtract({ days: diff });
};
