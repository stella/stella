import { getFirstWeekday, getWeekendDays } from "@stll/ui/lib/week";

export { getFirstWeekday, getWeekendDays };

/**
 * Midnight at the start of the week containing `date`, honoring the
 * locale's first weekday (local time).
 */
export const startOfWeek = (date: Date, locale: string): Date => {
  const firstWeekday = getFirstWeekday(locale);
  const diff = (date.getDay() - firstWeekday + 7) % 7;
  const start = new Date(date);
  start.setDate(date.getDate() - diff);
  start.setHours(0, 0, 0, 0);
  return start;
};
