/**
 * First weekday for a locale as a `Date.getDay()` value
 * (0 = Sunday … 6 = Saturday), derived from CLDR via Intl: Monday across
 * most of Europe, Sunday in the US, Saturday across much of the Gulf.
 * Falls back to Monday when the runtime lacks week info.
 */
export const getFirstWeekday = (locale: string): number => {
  try {
    const loc = new Intl.Locale(locale);
    // Newer engines expose getWeekInfo(); older ones the legacy `weekInfo`
    // accessor, which the lib types omit.
    const legacy = loc as Intl.Locale & { weekInfo?: Intl.WeekInfo };
    const info =
      typeof loc.getWeekInfo === "function"
        ? loc.getWeekInfo()
        : legacy.weekInfo;
    const firstDay = info?.firstDay;
    // Intl reports firstDay as 1 = Monday … 7 = Sunday; map to Date.getDay.
    return typeof firstDay === "number" ? firstDay % 7 : 1;
  } catch {
    return 1;
  }
};

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
