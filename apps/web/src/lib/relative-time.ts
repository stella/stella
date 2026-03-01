const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;
const WEEK = 604_800;
const MONTH = 2_592_000;
const YEAR = 31_536_000;

/**
 * Format a date as a relative time string using
 * `Intl.RelativeTimeFormat`. Returns short forms like
 * "2h ago", "yesterday", "3d ago".
 */
export const formatRelativeTime = (
  date: Date | string,
  locale: string,
): string => {
  const now = Date.now();
  const then =
    typeof date === "string" ? new Date(date).getTime() : date.getTime();
  const diff = Math.round((then - now) / 1000);
  const absDiff = Math.abs(diff);

  const rtf = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    style: "narrow",
  });

  if (absDiff < MINUTE) {
    // "just now" / "1 min. ago" — sub-minute precision is noise
    return rtf.format(0, "minute");
  }
  if (absDiff < HOUR) {
    return rtf.format(Math.trunc(diff / MINUTE), "minute");
  }
  if (absDiff < DAY) {
    return rtf.format(Math.trunc(diff / HOUR), "hour");
  }
  if (absDiff < WEEK) {
    return rtf.format(Math.trunc(diff / DAY), "day");
  }
  if (absDiff < MONTH) {
    return rtf.format(Math.trunc(diff / WEEK), "week");
  }
  if (absDiff < YEAR) {
    return rtf.format(Math.trunc(diff / MONTH), "month");
  }
  return rtf.format(Math.trunc(diff / YEAR), "year");
};
