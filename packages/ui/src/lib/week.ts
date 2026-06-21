/**
 * Locale week data (first weekday, weekend) derived from CLDR via Intl.
 * Shared so the app shell and the date picker resolve week starts identically.
 */

/**
 * Read CLDR week info for a locale, tolerating the legacy `weekInfo` accessor
 * on engines that predate `getWeekInfo()`. Returns undefined when unavailable
 * so callers can apply their own fallback.
 */
export const getLocaleWeekInfo = (
  locale: string,
): Intl.WeekInfo | undefined => {
  try {
    const loc = new Intl.Locale(locale);
    const legacy = loc as Intl.Locale & { weekInfo?: Intl.WeekInfo };
    return typeof loc.getWeekInfo === "function"
      ? loc.getWeekInfo()
      : legacy.weekInfo;
  } catch {
    return undefined;
  }
};

/**
 * First weekday as a `Date.getDay()` value (0 = Sunday … 6 = Saturday): Monday
 * across most of Europe, Sunday in the US, Saturday across much of the Gulf.
 * Falls back to Monday when the runtime lacks week info.
 */
export const getFirstWeekday = (locale: string): number => {
  const firstDay = getLocaleWeekInfo(locale)?.firstDay;
  // Intl reports firstDay as 1 = Monday … 7 = Sunday; map to Date.getDay.
  return typeof firstDay === "number" ? firstDay % 7 : 1;
};

/**
 * Weekend weekdays as `Date.getDay()` values (0 = Sunday … 6 = Saturday):
 * Saturday/Sunday across the West, Friday/Saturday across much of the Gulf.
 * Falls back to Saturday/Sunday when the runtime lacks week info.
 */
export const getWeekendDays = (locale: string): ReadonlySet<number> => {
  const weekend = getLocaleWeekInfo(locale)?.weekend;
  if (weekend && weekend.length > 0) {
    // Intl reports 1 = Monday … 7 = Sunday; map to Date.getDay (0 = Sunday).
    return new Set(weekend.map((day) => day % 7));
  }
  return new Set([0, 6]);
};
